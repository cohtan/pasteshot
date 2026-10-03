import { deleteTiles, failStaleSessions, pruneSessions, putSession, putTile, updateSession } from "./db.js";
import { MAX_TILES, scrollStops } from "./geometry.js";
import { t } from "./i18n.js";
import { getResolution } from "./settings.js";

const CAPTURE_INTERVAL_MS = 520;
let running = false;
let lastCapture = 0;
let injectedTabId = null;

// The progress and preview pages hold a "keepalive" port so the worker is not
// suspended mid-capture. The port needs a listener here to stay open.
chrome.runtime.onConnect.addListener((port) => {
  port.onDisconnect.addListener(() => {});
});

chrome.action.onClicked.addListener((tab) => {
  void runCapture(tab);
});

// Used by test/capture.mjs. Web pages cannot call this.
globalThis.pasteshotCaptureByUrl = async (url) => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((item) => item.url === url);
  if (!tab) throw new Error(`tab not found: ${tabs.map((item) => item.url || item.id).join(" | ")}`);
  return runCapture(tab);
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCapturable(url = "") {
  return /^(https?|file):/i.test(url);
}

function humanError(error) {
  const message = String(error?.message || error);
  if (error?.code === "resize" || message === "resize") {
    return t("errResize");
  }
  if (/Cannot access contents|gallery|chrome:\/\/|edge:\/\/|about:|restricted/i.test(message)) {
    return t("errRestricted");
  }
  return t("errGeneric");
}

async function setBadge(text) {
  await chrome.action.setBadgeText({ text }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: "#1d3c32" }).catch(() => {});
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: "#ffffff" }).catch(() => {});
  }
}

async function callPage(tabId, name, arg) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (fnName, payload) => window.__pasteshotApi[fnName](payload),
    args: [name, arg],
  });
  return result?.result;
}

async function captureTab(windowId) {
  const elapsed = Date.now() - lastCapture;
  if (lastCapture && elapsed < CAPTURE_INTERVAL_MS) await delay(CAPTURE_INTERVAL_MS - elapsed);
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    if (!/MAX_CAPTURE|quota/i.test(String(error?.message || error))) throw error;
    await delay(800);
    return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } finally {
    lastCapture = Date.now();
  }
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function ensureActive(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) await chrome.tabs.update(tabId, { active: true });
  return tab;
}

async function openPreview(sessionId) {
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`src/preview.html?id=${sessionId}`),
    active: true,
  });
  return tab.id;
}

async function openProgress(sessionId, windowId) {
  const url = chrome.runtime.getURL(`src/progress.html?id=${encodeURIComponent(sessionId)}`);
  let left = 80;
  let top = 72;
  try {
    const win = await chrome.windows.get(windowId);
    left = Math.max(0, Math.round((win.left || 0) + (win.width || 900) - 384));
    top = Math.max(0, Math.round((win.top || 0) + 72));
  } catch {
    /* The window position is optional. */
  }
  const created = await chrome.windows.create({
    url,
    type: "popup",
    focused: false,
  });
  await chrome.windows.update(created.id, {
    width: 380,
    height: 260,
    left,
    top,
    state: "normal",
    focused: false,
  });
  return created.id;
}

async function callOffscreen(sessionId) {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: "src/offscreen.html",
      reasons: ["CLIPBOARD", "BLOBS"],
      justification: t("offscreenJustification"),
    });
  }
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({ target: "offscreen", sessionId });
      if (response) return response;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw lastError || new Error("offscreen unavailable");
}

async function copyFromProgress(progressWindowId, sessionId) {
  await chrome.windows.update(progressWindowId, { focused: true });
  await delay(120);
  return chrome.runtime.sendMessage({ target: "progress", type: "copy", sessionId });
}

async function shoot(tabId, windowId, meta, sessionId) {
  const viewW = meta.crop.width;
  const viewH = meta.crop.height;
  let contentW = meta.contentWidth;
  let contentH = meta.contentHeight;
  let xStops = scrollStops(contentW, viewW);
  let truncatedX = false;
  const estimatedRows = scrollStops(contentH, viewH).length;
  if (xStops.length > 1 && xStops.length * estimatedRows > MAX_TILES) {
    truncatedX = true;
    xStops = [0];
  }

  const tiles = [];
  let truncatedY = false;
  let blocked = false;
  let y = 0;

  const report = async () => {
    const total = Math.min(MAX_TILES, Math.max(tiles.length, xStops.length * scrollStops(contentH, viewH).length));
    await setBadge(String(tiles.length));
    await chrome.action.setTitle({ title: t("actionTitleBusy", tiles.length) });
    await updateSession(sessionId, { phase: "scroll", current: tiles.length, total });
  };

  while (tiles.length < MAX_TILES) {
    for (let xi = 0; xi < xStops.length; xi += 1) {
      const x = xStops[xi];
      if (tiles.length >= MAX_TILES) {
        truncatedY = true;
        break;
      }
      await ensureActive(tabId);
      const pos = await callPage(tabId, "scrollTo", { x, y });
      const missed = Math.abs(pos.x - x) > 4 || Math.abs(pos.y - y) > 4;
      if (missed && tiles.length > 0) {
        blocked = true;
        break;
      }
      const dataUrl = await captureTab(windowId);
      const blob = await dataUrlToBlob(dataUrl);
      const tile = {
        sessionId,
        index: tiles.length,
        x: missed ? Math.round(pos.x) : x,
        y: missed ? Math.round(pos.y) : y,
        blob,
      };
      await putTile(tile);
      tiles.push({ index: tile.index, x: tile.x, y: tile.y });
      await report();
      if (missed) {
        blocked = true;
        break;
      }
      if (meta.mode === "element" && y === 0 && xi === xStops.length - 1) {
        await callPage(tabId, "hideChrome", null);
      }
    }
    if (blocked || truncatedY) break;

    const measured = await callPage(tabId, "measure", null);
    if (!measured) break;
    if (
      Math.abs(measured.viewportWidth - meta.viewportWidth) > 2 ||
      Math.abs(measured.viewportHeight - meta.viewportHeight) > 2
    ) {
      const error = new Error("resize");
      error.code = "resize";
      throw error;
    }
    contentW = Math.max(contentW, Math.round(measured.contentWidth));
    contentH = Math.max(contentH, Math.round(measured.contentHeight));
    const maxScroll = Math.max(0, contentH - viewH);
    if (y >= maxScroll - 1) break;
    const next = Math.min(y + viewH, maxScroll);
    if (next <= y) break;
    if (tiles.length + xStops.length > MAX_TILES) {
      truncatedY = true;
      break;
    }
    y = next;
  }

  if (tiles.length === 0) throw new Error("no tiles");

  const maxY = Math.max(...tiles.map((tile) => tile.y));
  const maxX = Math.max(...tiles.map((tile) => tile.x));
  const warnings = [];
  if (truncatedY) warnings.push(t("warnTruncatedY"));
  if (truncatedX) warnings.push(t("warnTruncatedX"));
  if (blocked) warnings.push(t("warnBlocked"));
  if (meta.mode === "element") {
    warnings.push(t("warnElement"));
  }

  return {
    warnings,
    contentWidth: Math.min(contentW, maxX + viewW),
    contentHeight: Math.min(contentH, maxY + viewH),
  };
}

async function runCapture(tab) {
  if (running || tab.id == null) return { ok: false, error: "busy" };
  running = true;
  const tabId = tab.id;
  const windowId = tab.windowId;
  let sessionId = null;
  let progressWindowId = null;
  let result = { ok: false, sessionId: null, copied: false, imageCount: 0 };

  try {
    // Nothing is running, so a session still marked as capturing was cut off
    // when the worker stopped. Fail it so its window closes and its tiles go.
    await failStaleSessions(t("errStalled"));
    await pruneSessions(4);
    sessionId = crypto.randomUUID();
    result.sessionId = sessionId;
    const capturable = isCapturable(tab.url);
    await putSession({
      id: sessionId,
      status: capturable ? "capturing" : "error",
      phase: capturable ? "start" : "error",
      title: tab.title || "",
      url: tab.url || "",
      createdAt: Date.now(),
      current: 0,
      total: null,
      warnings: [],
      error: capturable ? null : t("errRestricted"),
      meta: null,
      images: null,
      copied: false,
      imageCount: 0,
    });
    progressWindowId = await openProgress(sessionId, windowId).catch((error) => {
      console.error(error);
      return null;
    });
    if (!capturable) {
      result.error = t("errRestricted");
      return result;
    }

    await setBadge("…");
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/page-hook.js"],
    });
    injectedTabId = tabId;
    const meta = await callPage(tabId, "prepare", null);
    const shot = await shoot(tabId, windowId, meta, sessionId);
    const resolution = await getResolution();
    await updateSession(sessionId, {
      phase: "copy",
      title: meta.title || tab.title || "",
      url: meta.url || tab.url || "",
      warnings: shot.warnings,
      meta: {
        mode: meta.mode,
        background: meta.background,
        viewportWidth: meta.viewportWidth,
        viewportHeight: meta.viewportHeight,
        crop: meta.crop,
        contentWidth: shot.contentWidth,
        contentHeight: shot.contentHeight,
        resolution: resolution.id,
      },
    });
    const stitched = await callOffscreen(sessionId);
    if (!stitched?.ok) throw new Error(stitched?.error || "stitch failed");
    let copied = Boolean(stitched.copied);
    let method = stitched.method || "";
    if (!copied && progressWindowId) {
      const viaWindow = await copyFromProgress(progressWindowId, sessionId).catch((error) => ({
        ok: false,
        error: String(error?.message || error),
      }));
      copied = Boolean(viaWindow?.ok);
      method = viaWindow?.method || method;
      if (!copied) result.copyError = viaWindow?.error || stitched.error || "";
    }
    const imageCount = stitched.imageCount || 0;
    const phase = copied ? (imageCount > 1 ? "multi" : "done") : "manual";
    await updateSession(sessionId, { status: "ready", phase, copied, imageCount });
    if (!copied) await openPreview(sessionId).catch(() => {});
    result = { ok: true, sessionId, copied, imageCount, method, copyError: result.copyError || "" };
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    result = { ok: false, sessionId, copied: false, imageCount: 0, error: humanError(error) };
    if (sessionId) {
      await updateSession(sessionId, {
        status: "error",
        phase: "error",
        error: humanError(error),
        detail: String(error?.stack || error?.message || error),
      }).catch(() => {});
      await deleteTiles(sessionId).catch(() => {});
    }
  } finally {
    if (injectedTabId != null) {
      await callPage(injectedTabId, "restore", null).catch(() => {});
      injectedTabId = null;
    }
    await setBadge("");
    await chrome.action.setTitle({ title: t("actionTitle") }).catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
    running = false;
  }
  return result;
}
