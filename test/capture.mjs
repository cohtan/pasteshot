import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browsers = [
  process.env.PASTESHOT_BROWSER || "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

function distance(actual, expected) {
  return Math.max(...expected.map((channel, index) => Math.abs(channel - actual[index])));
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    this.waiters = [];
    this.logs = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.consoleAPICalled") {
        const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
        this.logs.push(text);
      }
      if (message.method === "Runtime.exceptionThrown") {
        this.logs.push(message.params.exceptionDetails?.exception?.description || "exception");
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
        return;
      }
      for (const waiter of this.waiters) waiter(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.next;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  once(method, sessionId) {
    return new Promise((resolve) => {
      const waiter = (message) => {
        if (message.method !== method) return;
        if (sessionId && message.sessionId !== sessionId) return;
        this.waiters = this.waiters.filter((item) => item !== waiter);
        resolve(message.params);
      };
      this.waiters.push(waiter);
    });
  }
}

async function listen(rootDir) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(rootDir, pathname);
    if (!file.startsWith(`${rootDir}${path.sep}`) && file !== rootDir) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200).end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

async function waitForJson(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return response.json();
    } catch {
      /* Chrome is still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Chrome DevTools did not start");
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId).catch(() => {});
  return sessionId;
}

async function openPage(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url });
  const sessionId = await attach(cdp, targetId);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, sessionId, "document.readyState");
    if (ready === "complete") return { targetId, sessionId };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`page did not load: ${url}`);
}

async function findTarget(cdp, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const found = targetInfos.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const { targetInfos } = await cdp.send("Target.getTargets");
  throw new Error(`target not found: ${targetInfos.map((item) => `${item.type} ${item.url}`).join("\n")}`);
}

function expectedColor(layout, y) {
  const header = layout.boxes.find((box) => box.overlay === "top");
  const footer = layout.boxes.find((box) => box.overlay === "bottom");
  if (header && y < header.height) return header.color;
  if (footer && y >= layout.scrollHeight - footer.height) return footer.color;
  const box = layout.boxes.find((item) => !item.overlay && y >= item.top && y < item.bottom);
  return box?.color ?? null;
}

async function sampleImage(cdp, sessionId, probes) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const img = document.querySelector("img");
      const capture = globalThis.__capture;
      if (!img?.naturalWidth || !capture) return null;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const probes = ${JSON.stringify(probes)};
      return {
        width: canvas.width,
        height: canvas.height,
        status: document.querySelector("#status")?.textContent || "",
        capture,
        probes: probes.map((probe) => ({
          ...probe,
          color: [...ctx.getImageData(probe.x, probe.y, 1, 1).data].slice(0, 3),
        })),
      };
    })()`,
  );
}

async function captureFixture(cdp, pageUrl, shotName) {
  const worker = await findTarget(
    cdp,
    (target) => target.type === "service_worker" && target.url.includes("background.js"),
    15000,
  );
  const workerSession = await attach(cdp, worker.targetId);
  const { targetId, sessionId } = await openPage(cdp, pageUrl);
  const layout = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const scrolling = document.scrollingElement;
      const scroller = document.querySelector("#scroller");
      const boxes = [...document.querySelectorAll("[data-color]")].map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          color: el.dataset.color,
          overlay: el.dataset.overlay || "",
          top: rect.top + window.scrollY,
          bottom: rect.bottom + window.scrollY,
          height: rect.height,
          left: rect.left,
        };
      });
      return {
        scrollHeight: scrolling.scrollHeight,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scroller: scroller ? {
          scrollHeight: scroller.scrollHeight,
          left: scroller.getBoundingClientRect().left,
          top: scroller.getBoundingClientRect().top,
        } : null,
        boxes,
      };
    })()`,
  );
  const extensionId = new URL(worker.url).host;
  let progressSaved = false;
  const watchProgress = async () => {
    const deadline = Date.now() + 20000;
    while (!progressSaved && Date.now() < deadline) {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const progress = targetInfos.find((target) => target.type === "page" && target.url.includes("progress.html"));
      if (progress) {
        const progressSession = await attach(cdp, progress.targetId);
        const title = await evaluate(cdp, progressSession, `document.querySelector("#title")?.textContent || ""`);
        const box = await evaluate(cdp, progressSession, "({ width: window.outerWidth, height: window.outerHeight })");
        if (title && box.width <= 420) {
          const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, progressSession);
          await writeFile(`/tmp/pasteshot-progress-${shotName}.png`, Buffer.from(shot.data, "base64"));
          progressSaved = true;
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const result = await Promise.all([
    evaluate(cdp, workerSession, `globalThis.pasteshotCaptureByUrl(${JSON.stringify(pageUrl)})`),
    watchProgress(),
  ]).then(([value]) => value);
  if (!result?.ok) {
    throw new Error(`capture failed: ${JSON.stringify(result)}\n${cdp.logs.join("\n")}`);
  }
  if (!progressSaved) throw new Error("progress window did not appear");
  const opened = await openPage(cdp, `chrome-extension://${extensionId}/src/preview.html?id=${result.sessionId}`);
  return { layout, targetId, sessionId, previewSession: opened.sessionId, previewTargetId: opened.targetId, result };
}

function assertColor(sample, probe, label) {
  const actual = sample.probes.find((item) => item.name === probe.name);
  const delta = distance(actual.color, hexToRgb(probe.color));
  if (delta > 24) {
    throw new Error(`${label} ${probe.name}: expected ${probe.color}, got rgb(${actual.color.join(",")}) at ${probe.x},${probe.y}`);
  }
}

// Starts a capture, cancels it from the progress window ("button") or by
// closing that window ("close"), and checks the page is left as it was.
async function runCancelFixture(cdp, origin, how) {
  const pageUrl = `${origin}/fixture.html?cancel=${how}`;
  const worker = await findTarget(
    cdp,
    (target) => target.type === "service_worker" && target.url.includes("background.js"),
    15000,
  );
  const workerSession = await attach(cdp, worker.targetId);
  const { sessionId: pageSession } = await openPage(cdp, pageUrl);
  // Progress windows from earlier captures may still be closing; skip them.
  const before = new Set((await cdp.send("Target.getTargets")).targetInfos.map((target) => target.targetId));
  const running = evaluate(cdp, workerSession, `globalThis.pasteshotCaptureByUrl(${JSON.stringify(pageUrl)})`);

  let progress = null;
  let progressSession = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    progress = targetInfos.find(
      (target) => target.type === "page" && target.url.includes("progress.html") && !before.has(target.targetId),
    );
    if (progress) {
      progressSession ??= await attach(cdp, progress.targetId);
      const ready = await evaluate(
        cdp,
        progressSession,
        `!document.querySelector("#cancel-row").hidden && document.querySelector("#bar").style.width !== ""`,
      ).catch(() => false);
      if (ready) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!progressSession) throw new Error(`cancel/${how}: progress window did not appear`);

  if (how === "button") {
    await evaluate(cdp, progressSession, `document.querySelector("#cancel").click()`);
  } else {
    await cdp.send("Target.closeTarget", { targetId: progress.targetId });
  }
  const result = await running;
  if (!result?.cancelled) throw new Error(`cancel/${how}: capture was not cancelled: ${JSON.stringify(result)}`);

  if (how === "button") {
    const title = await evaluate(cdp, progressSession, `document.querySelector("#title").textContent`).catch(() => "");
    const closed = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        const { targetInfos } = await cdp.send("Target.getTargets");
        if (!targetInfos.some((target) => target.targetId === progress.targetId)) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    })();
    if (!closed) throw new Error(`cancel/button: progress window stayed open (title "${title}")`);
  }

  const page = await evaluate(
    cdp,
    pageSession,
    `({ hook: Boolean(window.__pasteshot), style: Boolean(document.getElementById("pasteshot-capture-style")), y: window.scrollY })`,
  );
  if (page.hook || page.style || page.y !== 0) {
    throw new Error(`cancel/${how}: page was not restored: ${JSON.stringify(page)}`);
  }
  console.log(`cancel ok via ${how}`);
}

async function runWindowFixture(cdp, origin) {
  const pageUrl = `${origin}/fixture.html`;
  const { layout, sessionId, previewSession, previewTargetId, result } = await captureFixture(cdp, pageUrl, "window");
  if (!result.copied) throw new Error(`window image was not copied: ${JSON.stringify(result)}`);
  let sample = null;
  for (let i = 0; i < 40 && !sample; i += 1) {
    sample = await sampleImage(cdp, previewSession, []);
    if (!sample) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!sample) {
    const status = await evaluate(cdp, previewSession, `document.querySelector("#status")?.textContent || ""`);
    const detail = await evaluate(
      cdp,
      previewSession,
      `new Promise((resolve) => {
        const req = indexedDB.open("pasteshot");
        req.onsuccess = () => {
          const get = req.result.transaction("sessions").objectStore("sessions").getAll();
          get.onsuccess = () => resolve(get.result.map((item) => item.detail || item.error));
        };
        req.onerror = () => resolve(["idb error"]);
      })`,
    );
    throw new Error(`preview did not produce an image: ${status}\n${JSON.stringify(detail)}\n${cdp.logs.join("\n")}`);
  }
  const scaleX = sample.width / layout.innerWidth;
  const scaleY = sample.height / layout.scrollHeight;
  if (Math.abs(sample.height - layout.scrollHeight * Math.min(1, 1280 / layout.innerWidth)) > 8) {
    throw new Error(`height ${sample.height} != page ${layout.scrollHeight} (viewport ${layout.innerHeight})`);
  }
  const ys = [10, 60, layout.innerHeight - 8, layout.innerHeight + 8, layout.scrollHeight - 10];
  const probes = ys.map((y, index) => ({
    name: `y${index}`,
    x: Math.max(0, Math.min(sample.width - 1, Math.round((layout.innerWidth - 36) * scaleX))),
    y: Math.max(0, Math.min(sample.height - 1, Math.round(y * scaleY))),
    color: expectedColor(layout, y),
  }));
  const measured = await sampleImage(cdp, previewSession, probes);
  for (const probe of probes) assertColor(measured, probe, "window");
  const restored = await evaluate(
    cdp,
    sessionId,
    `({
      position: getComputedStyle(document.querySelector("header")).position,
      sticky: getComputedStyle(document.querySelector(".sticky")).position,
      style: Boolean(document.getElementById("pasteshot-capture-style")),
    })`,
  );
  if (restored.position !== "fixed" || restored.sticky !== "sticky" || restored.style) {
    throw new Error(`page was not restored: ${JSON.stringify(restored)}`);
  }
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, previewSession);
  await writeFile("/tmp/pasteshot-window.png", Buffer.from(shot.data, "base64"));
  await assertClipboard(cdp, previewTargetId, previewSession);
  console.log(`window ok ${sample.width}x${sample.height} via ${result.method}`);
}

async function runInnerFixture(cdp, origin) {
  const pageUrl = `${origin}/fixture-inner.html`;
  const { layout, previewSession, previewTargetId, result } = await captureFixture(cdp, pageUrl, "inner");
  if (!result.copied) throw new Error(`inner image was not copied: ${JSON.stringify(result)}`);
  let sample = null;
  for (let i = 0; i < 40 && !sample; i += 1) {
    sample = await sampleImage(cdp, previewSession, []);
    if (!sample) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!sample) throw new Error("inner preview did not produce an image");
  if (sample.height < layout.innerHeight + 200) {
    throw new Error(`inner image is only ${sample.height}px, viewport is ${layout.innerHeight}`);
  }
  const expectedHeight = layout.scroller.scrollHeight + layout.scroller.top + (layout.innerHeight - layout.scroller.top - (layout.innerHeight - layout.scroller.top));
  // top chrome + scrolled content. The scroller fills the viewport in this fixture.
  if (Math.abs(sample.height - layout.scroller.scrollHeight) > 12 && Math.abs(sample.height - expectedHeight) > 12) {
    throw new Error(`inner height ${sample.height}, scrollHeight ${layout.scroller.scrollHeight}`);
  }
  const probes = [
    {
      name: "side",
      x: 120,
      y: 48,
      color: "#663399",
    },
    {
      name: "tail",
      x: Math.min(sample.width - 10, Math.round(layout.scroller.left + 180)),
      y: sample.height - 40,
      color: "#ffcc00",
    },
  ];
  const measured = await sampleImage(cdp, previewSession, probes);
  for (const probe of probes) assertColor(measured, probe, "inner");
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, previewSession);
  await writeFile("/tmp/pasteshot-inner.png", Buffer.from(shot.data, "base64"));
  await assertClipboard(cdp, previewTargetId, previewSession);
  console.log(`inner ok ${sample.width}x${sample.height} mode=${sample.capture.meta.mode} via ${result.method}`);
}

async function assertClipboard(cdp, targetId, previewSession) {
  await cdp.send("Target.activateTarget", { targetId });
  await cdp.send("Page.bringToFront", {}, previewSession);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const copied = await evaluate(
    cdp,
    previewSession,
    `(async () => {
      const items = await navigator.clipboard.read();
      const type = items[0].types.find((item) => item.startsWith("image/")) || items[0].types[0];
      const blob = await items[0].getType(type);
      return { type, size: blob.size, types: items[0].types };
    })()`,
  );
  if (copied.type !== "image/png" || copied.size < 1000) {
    throw new Error(`clipboard was ${JSON.stringify(copied)}`);
  }
  console.log("clipboard", copied);
}

async function launch(browser, extensionDir, port) {
  const profile = await mkdtemp(path.join(tmpdir(), "pasteshot-profile-"));
  const logs = [];
  const child = spawn(
    browser,
    [
      `--user-data-dir=${profile}`,
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--window-size=1100,860",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const collect = (chunk) => logs.push(chunk.toString());
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return {
    child,
    profile,
    logs,
    async close() {
      child.kill("SIGKILL");
      spawn("pkill", ["-f", profile]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await rm(profile, { recursive: true, force: true });
    },
  };
}

async function main() {
  const extensionDir = await mkdtemp(path.join(tmpdir(), "pasteshot-ext-"));
  await cp(path.join(root, "src"), path.join(extensionDir, "src"), { recursive: true });
  await cp(path.join(root, "icons"), path.join(extensionDir, "icons"), { recursive: true });
  await cp(path.join(root, "_locales"), path.join(extensionDir, "_locales"), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  // captureVisibleTab accepts <all_urls> or a real toolbar click. The test
  // cannot click the toolbar, so this copy of the manifest grants host access.
  // clipboardRead is only for checking the copied image in this test.
  manifest.permissions = [...new Set([...(manifest.permissions || []), "clipboardRead"])];
  await writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const { server, port: httpPort } = await listen(path.join(root, "test"));
  const origin = `http://127.0.0.1:${httpPort}`;
  let browserSession = null;
  try {
    let lastError = null;
    for (const browser of browsers) {
      const debugPort = 9400 + browsers.indexOf(browser);
      browserSession = await launch(browser, extensionDir, debugPort);
      try {
        const version = await waitForJson(debugPort);
        const ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener("open", resolve);
          ws.addEventListener("error", reject);
        });
        const cdp = new Cdp(ws);
        const worker = await findTarget(
          cdp,
          (target) => target.type === "service_worker" && target.url.includes("background.js"),
          8000,
        ).catch((error) => {
          throw new Error(`${error.message}\n${browserSession.logs.join("").slice(-2000)}`);
        });
        console.log(`browser ${path.basename(browser)} extension ${worker.url}`);
        await runWindowFixture(cdp, origin);
        await runInnerFixture(cdp, origin);
        await runCancelFixture(cdp, origin, "button");
        await runCancelFixture(cdp, origin, "close");
        ws.close();
        return;
      } catch (error) {
        lastError = error;
        console.error(`failed with ${browser}: ${error.message}`);
        await browserSession.close();
        browserSession = null;
      }
    }
    throw lastError || new Error("no browser could load the extension");
  } finally {
    server.close();
    if (browserSession) await browserSession.close();
    await rm(extensionDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
