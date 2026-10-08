import {
  allSessions,
  deleteSession,
  deleteTiles,
  failStaleSessions,
  pruneSessions,
  putSession,
  putTile,
  updateSession,
} from "./db.js";
import { MAX_TILES, scrollStops } from "./geometry.js";
import { t } from "./i18n.js";
import { getResolution } from "./settings.js";
import { MAX_RECORD_MS, recordingFileName, videoSize } from "./video.js";

const CAPTURE_INTERVAL_MS = 520;
const POPUP = "src/popup.html";
let running = false;
let lastCapture = 0;
let injectedTabId = null;
// The capture in progress: { sessionId, progressWindowId, cancellable, cancelled }.
let active = null;
// The recording in progress: { sessionId, tabId, title, progressWindowId, timer, stopping }.
let recording = null;
// Sessions whose progress or preview page was just opened. A page that is
// still loading may not be listed as a context yet.
const opening = new Set();

// While a capture or recording runs, the toolbar button skips the menu so a
// click reaches onClicked and cancels or stops. A worker that restarts has
// nothing running, so the menu comes back.
function setBusy(busy) {
  return chrome.action.setPopup({ popup: busy ? "" : POPUP }).catch(() => {});
}
void setBusy(false);

// The progress and preview pages hold a "keepalive" port so the worker is not
// suspended mid-capture. The port needs a listener here to stay open.
chrome.runtime.onConnect.addListener((port) => {
  port.onDisconnect.addListener(() => {});
});

// A session holds images or a video of a page, with its title and URL.
// Once no progress or preview page shows it, it is deleted. Nothing is open
// when the worker starts with the browser, so old sessions go then too.
async function releaseUnviewed(closedTabId = null) {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
  const viewed = new Set(opening);
  for (const context of contexts) {
    if (context.tabId === closedTabId) continue;
    const id = new URL(context.documentUrl).searchParams.get("id");
    if (id) viewed.add(id);
  }
  if (active?.sessionId) viewed.add(active.sessionId);
  if (recording?.sessionId) viewed.add(recording.sessionId);
  for (const session of await allSessions()) {
    if (!viewed.has(session.id)) await deleteSession(session.id);
  }
}

function holdWhileOpening(sessionId) {
  opening.add(sessionId);
  setTimeout(() => opening.delete(sessionId), 5000);
}

void releaseUnviewed().catch((error) => console.error(error));

chrome.tabs.onRemoved.addListener((tabId) => {
  void releaseUnviewed(tabId).catch((error) => console.error(error));
});

// The menu is off while busy, so a click here cancels a capture or stops a
// recording. It only starts a capture if the menu could not be set.
chrome.action.onClicked.addListener((tab) => {
  if (recording) void stopRecording();
  else if (running) requestCancel();
  else void runCapture(tab);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "background") return;
  if (message.type === "start") {
    // From the menu. Answer first so the menu can close.
    sendResponse({ ok: !running });
    void startFromMenu(message.mode, message.tabId);
    return;
  }
  if (message.type === "cancel" && active && message.sessionId === active.sessionId) requestCancel();
  if ((message.type === "stop" || message.type === "record-ended") && recording?.sessionId === message.sessionId) {
    void stopRecording();
  }
  // "record-tick" only keeps the worker awake.
});

// Closing the progress window means the user no longer wants the capture.
// For a recording it means "done": the video is still saved.
chrome.windows.onRemoved.addListener((windowId) => {
  if (active && windowId === active.progressWindowId) requestCancel();
  if (recording && windowId === recording.progressWindowId) {
    recording.progressWindowId = null;
    void stopRecording();
  }
});

// A new page in the recorded tab needs the click ripples again.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (recording && !recording.stopping && tabId === recording.tabId && changeInfo.status === "complete") {
    void injectClicks(tabId);
  }
});

async function startFromMenu(mode, tabId) {
  if (running || tabId == null) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  if (mode === "record") await runRecording(tab);
  else await runCapture(tab);
}

// Cancelling is only possible while scrolling. Stitching is short and is
// left to finish so a copy is never cut in half.
function requestCancel() {
  if (active?.cancellable) active.cancelled = true;
}

function throwIfCancelled() {
  if (!active?.cancelled) return;
  const error = new Error("cancel");
  error.code = "cancel";
  throw error;
}

// Used by test/capture.mjs. Web pages cannot call this.
globalThis.pasteshotCaptureByUrl = async (url) => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((item) => item.url === url);
  if (!tab) throw new Error(`tab not found: ${tabs.map((item) => item.url || item.id).join(" | ")}`);
  return runCapture(tab);
};

// Used by test/capture.mjs. Starts recording the tab, waits, and stops.
globalThis.pasteshotRecordByUrl = async (url, ms = 2000) => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((item) => item.url === url);
  if (!tab) throw new Error("tab not found");
  const started = await runRecording(tab);
  if (!started.ok) return started;
  await delay(ms);
  return stopRecording();
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCapturable(url = "") {
  return /^(https?|file):/i.test(url);
}

function humanError(error, fallback = "errGeneric") {
  const message = String(error?.message || error);
  if (error?.code === "resize" || message === "resize") {
    return t("errResize");
  }
  if (/Cannot access contents|gallery|chrome:\/\/|edge:\/\/|about:|restricted/i.test(message)) {
    return t("errRestricted");
  }
  return t(fallback);
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
  holdWhileOpening(sessionId);
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`src/preview.html?id=${sessionId}`),
    active: true,
  });
  return tab.id;
}

async function openProgress(sessionId, windowId) {
  holdWhileOpening(sessionId);
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

async function callOffscreen(sessionId, extra = {}) {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length === 0) {
    await chrome.offscreen.createDocument({
      url: "src/offscreen.html",
      reasons: ["CLIPBOARD", "BLOBS", "USER_MEDIA"],
      justification: t("offscreenJustification"),
    });
  }
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({ target: "offscreen", sessionId, ...extra });
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
    await chrome.action.setTitle({ title: t("actionTitleBusyCancel", tiles.length) });
    await updateSession(sessionId, { phase: "scroll", current: tiles.length, total });
  };

  while (tiles.length < MAX_TILES) {
    for (let xi = 0; xi < xStops.length; xi += 1) {
      const x = xStops[xi];
      if (tiles.length >= MAX_TILES) {
        truncatedY = true;
        break;
      }
      throwIfCancelled();
      await ensureActive(tabId);
      const pos = await callPage(tabId, "scrollTo", { x, y });
      const missed = Math.abs(pos.x - x) > 4 || Math.abs(pos.y - y) > 4;
      if (missed && tiles.length > 0) {
        blocked = true;
        break;
      }
      const dataUrl = await captureTab(windowId);
      throwIfCancelled();
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
  await setBusy(true);
  active = { sessionId: null, progressWindowId: null, cancellable: true, cancelled: false };
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
    active.sessionId = sessionId;
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
    active.progressWindowId = progressWindowId;
    if (!capturable) {
      result.error = t("errRestricted");
      return result;
    }

    throwIfCancelled();
    await setBadge("…");
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/page-hook.js"],
    });
    injectedTabId = tabId;
    const meta = await callPage(tabId, "prepare", null);
    throwIfCancelled();
    const shot = await shoot(tabId, windowId, meta, sessionId);
    throwIfCancelled();
    active.cancellable = false;
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
    if (error?.code === "cancel") {
      result = { ok: false, sessionId, copied: false, imageCount: 0, cancelled: true };
      if (sessionId) {
        await updateSession(sessionId, { status: "cancelled", phase: "cancelled" }).catch(() => {});
        await deleteTiles(sessionId).catch(() => {});
      }
      return result;
    }
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
    active = null;
    running = false;
    await setBusy(false);
  }
  return result;
}

async function injectClicks(tabId) {
  const target = { tabId, allFrames: true };
  try {
    await chrome.scripting.executeScript({ target, files: ["src/clicks.js"] });
  } catch {
    // Without access to every frame, draw in the top frame at least.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["src/clicks.js"] }).catch(() => {});
  }
}

async function removeClicks(tabId) {
  await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, func: () => window.__pasteshotClicks?.remove() })
    .catch(() => {});
}

async function viewportOf(tab) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio }),
    });
    if (result?.result?.width) return result.result;
  } catch {
    /* Fall back to the tab size. */
  }
  return { width: tab.width || 1280, height: tab.height || 720, ratio: 1 };
}

async function runRecording(tab) {
  if (running || tab.id == null) return { ok: false, error: "busy" };
  running = true;
  await setBusy(true);
  const tabId = tab.id;
  const sessionId = crypto.randomUUID();
  recording = { sessionId, tabId, title: tab.title || "", progressWindowId: null, timer: 0, stopping: false };

  try {
    await failStaleSessions(t("errStalled"));
    await pruneSessions(4);
    const capturable = isCapturable(tab.url);
    await putSession({
      id: sessionId,
      kind: "record",
      status: capturable ? "recording" : "error",
      phase: capturable ? "start" : "error",
      title: tab.title || "",
      url: tab.url || "",
      createdAt: Date.now(),
      startedAt: null,
      warnings: [],
      error: capturable ? null : t("errRestricted"),
      fileName: null,
      video: null,
    });
    recording.progressWindowId = await openProgress(sessionId, tab.windowId).catch((error) => {
      console.error(error);
      return null;
    });
    if (!capturable) throw Object.assign(new Error("restricted"), { code: "restricted" });

    // Ask for the stream first: it must follow the click in the menu closely.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const viewport = await viewportOf(tab);
    const size = videoSize(viewport.width, viewport.height, viewport.ratio);
    const started = await callOffscreen(sessionId, { type: "record-start", streamId, ...size });
    if (!started?.ok) throw new Error(started?.error || "record failed");
    await injectClicks(tabId);
    await updateSession(sessionId, { phase: "record", startedAt: Date.now(), videoType: started.mimeType });
    await setBadge("REC");
    await chrome.action.setBadgeBackgroundColor({ color: "#c62828" }).catch(() => {});
    await chrome.action.setTitle({ title: t("actionTitleRecording") }).catch(() => {});
    recording.timer = setTimeout(() => void stopRecording({ autoStopped: true }), MAX_RECORD_MS);
    return { ok: true, sessionId };
  } catch (error) {
    if (error?.code !== "restricted") console.error(error?.stack || error?.message || String(error));
    const message = error?.code === "restricted" ? t("errRestricted") : humanError(error, "errRecord");
    await updateSession(sessionId, {
      status: "error",
      phase: "error",
      error: message,
      detail: String(error?.stack || error?.message || error),
    }).catch(() => {});
    await finishRecording(tabId);
    return { ok: false, sessionId, error: message };
  }
}

async function finishRecording(tabId) {
  clearTimeout(recording?.timer);
  await removeClicks(tabId);
  await setBadge("");
  await chrome.action.setTitle({ title: t("actionTitle") }).catch(() => {});
  await chrome.offscreen.closeDocument().catch(() => {});
  recording = null;
  running = false;
  await setBusy(false);
}

async function stopRecording({ autoStopped = false } = {}) {
  const current = recording;
  if (!current || current.stopping) return { ok: false, error: "not recording" };
  current.stopping = true;
  const { sessionId, tabId } = current;
  let result;
  try {
    await updateSession(sessionId, { phase: "save" });
    const stopped = await callOffscreen(sessionId, { type: "record-stop" });
    if (!stopped?.ok) throw new Error(stopped?.error || "stop failed");
    const fileName = recordingFileName(current.title, new Date(), stopped.type);
    const warnings = autoStopped ? [t("warnRecordLimit")] : [];
    await updateSession(sessionId, { status: "ready", phase: "saved", fileName, stoppedAt: Date.now(), warnings });
    // The progress window saves the file, so it has to be open.
    if (!current.progressWindowId) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const windowId = tab?.windowId ?? (await chrome.windows.getLastFocused().catch(() => null))?.id;
      await openProgress(sessionId, windowId).catch((error) => console.error(error));
    }
    result = { ok: true, sessionId, fileName, type: stopped.type, size: stopped.size };
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    const message = humanError(error, "errRecordSave");
    await updateSession(sessionId, {
      status: "error",
      phase: "error",
      error: message,
      detail: String(error?.stack || error?.message || error),
    }).catch(() => {});
    result = { ok: false, sessionId, error: message };
  } finally {
    await finishRecording(tabId);
  }
  return result;
}
