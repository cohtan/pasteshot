import { getSession, updateSession } from "./db.js";
import { localize, t } from "./i18n.js";
import { copyPng } from "./stitch.js";
import { extensionForVideo, formatElapsed } from "./video.js";

localize();

const sessionId = new URLSearchParams(location.search).get("id");
const titleEl = document.querySelector("#title");
const detailEl = document.querySelector("#detail");
const noteEl = document.querySelector("#note");
const trackEl = document.querySelector("#track");
const barEl = document.querySelector("#bar");
const actionsEl = document.querySelector("#actions");
const cancelRowEl = document.querySelector("#cancel-row");
const cancelButton = document.querySelector("#cancel");
const stepsEl = document.querySelector("#steps");
const steps = {
  start: document.querySelector("#step-start"),
  scroll: document.querySelector("#step-scroll"),
  copy: document.querySelector("#step-copy"),
};

const DONE_CLOSE_MS = 1000;
const ERROR_CLOSE_MS = 6000;
const CANCEL_CLOSE_MS = 1000;

let rendered = "";
let closing = false;
let cancelling = false;
let recordMode = false;
let recordStartedAt = 0;
let downloadStarted = false;
let downloadId = null;

function closeLater(ms) {
  if (closing) return;
  closing = true;
  window.setTimeout(() => window.close(), ms);
}

async function fitWindow(height) {
  try {
    const current = await chrome.windows.getCurrent();
    if (current.type !== "popup") return;
    if (current.width === 380 && current.height === height) return;
    await chrome.windows.update(current.id, { width: 380, height, state: "normal" });
  } catch {
    /* The window may already be closing. */
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "progress" || message.sessionId !== sessionId || message.type !== "copy") return;
  void copyStored(0)
    .then(() => sendResponse({ ok: true, method: "progress" }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

function markSteps(active) {
  const order = ["start", "scroll", "copy"];
  const activeIndex = active === "done" ? order.length - 1 : order.indexOf(active);
  for (const [name, el] of Object.entries(steps)) {
    const index = order.indexOf(name);
    el.classList.toggle("current", index === activeIndex);
    el.classList.toggle("done", index < activeIndex);
  }
}

function button(label, onClick, quiet = false) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  if (quiet) el.className = "quiet";
  el.addEventListener("click", onClick);
  return el;
}

async function copyStored(index) {
  const session = await getSession(sessionId);
  const image = session?.images?.[index];
  if (!image) throw new Error("missing image");
  await copyPng(image.blob);
  detailEl.textContent = session.images.length > 1
    ? t("copiedNthPaste", index + 1)
    : t("copiedPaste");
}

async function saveVideo(session) {
  if (session.downloadId != null) downloadId = session.downloadId;
  if (downloadStarted || downloadId != null) return;
  downloadStarted = true;
  const url = URL.createObjectURL(session.video);
  try {
    downloadId = await chrome.downloads.download({ url, filename: session.fileName, conflictAction: "uniquify" });
  } catch {
    // Fall back to a plain name if the browser rejects the title in it.
    const filename = `PasteShot.${extensionForVideo(session.videoType)}`;
    downloadId = await chrome.downloads.download({ url, filename, conflictAction: "uniquify" });
  }
  await updateSession(sessionId, { downloadId });
}

function showElapsed() {
  if (!recordStartedAt || cancelling) return;
  const elapsed = formatElapsed(Date.now() - recordStartedAt);
  detailEl.textContent = elapsed;
  document.title = `${t("progRecTitle")} ${elapsed}`;
}

function renderRecording(session) {
  const key = JSON.stringify({
    phase: session.phase,
    status: session.status,
    cursorLimited: session.cursorLimited,
    error: session.error,
    downloadId,
  });
  if (key === rendered) return;
  rendered = key;

  const phase = session.phase || "start";
  recordMode = true;
  stepsEl.hidden = true;
  trackEl.hidden = true;
  noteEl.hidden = true;
  actionsEl.hidden = true;
  actionsEl.replaceChildren();
  titleEl.classList.toggle("recording", phase === "record");
  cancelButton.textContent = t("stopRecording");
  cancelButton.className = "stop";
  cancelRowEl.hidden = phase !== "record";
  recordStartedAt = phase === "record" ? session.startedAt || Date.now() : 0;

  if (phase === "error" || session.status === "error") {
    void fitWindow(300);
    titleEl.textContent = t("progRecErrorTitle");
    detailEl.textContent = session.error || t("tryAgain");
    actionsEl.hidden = false;
    actionsEl.append(button(t("close"), () => window.close(), true));
    document.title = t("progRecErrorTitle");
    closeLater(ERROR_CLOSE_MS);
    return;
  }

  if (phase === "saved") {
    void fitWindow(session.warnings?.length ? 300 : 260);
    const title = downloadId == null ? t("progRecSaveTitle") : t("progRecSavedTitle");
    titleEl.textContent = title;
    document.title = title;
    detailEl.textContent = downloadId == null ? t("progRecSaving") : t("progRecSavedDetail", session.fileName);
    if (session.warnings?.length) {
      noteEl.hidden = false;
      noteEl.textContent = session.warnings[0];
    }
    actionsEl.hidden = false;
    if (downloadId != null) {
      actionsEl.append(button(t("showInFolder"), () => chrome.downloads.show(downloadId)));
    }
    actionsEl.append(button(t("close"), () => window.close(), true));
    void saveVideo(session).catch((error) => {
      console.error(error);
      downloadStarted = false;
      detailEl.textContent = t("progRecDownloadFailed");
      actionsEl.prepend(button(t("download"), () => void saveVideo(session).then(() => { rendered = ""; })));
    });
    return;
  }

  if (phase === "save") {
    void fitWindow(260);
    titleEl.textContent = t("progRecSaveTitle");
    detailEl.textContent = t("progRecSaving");
    document.title = t("progRecSaveTitle");
    return;
  }

  if (phase === "record") {
    void fitWindow(session.cursorLimited ? 320 : 280);
    titleEl.textContent = t("progRecTitle");
    showElapsed();
    noteEl.hidden = false;
    noteEl.textContent = session.cursorLimited ? t("progRecCursorLimited") : t("progRecHint");
    if (session.cursorLimited) {
      actionsEl.hidden = false;
      actionsEl.append(button(t("allowAllSites"), () => {
        void chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => {});
      }, true));
    }
    return;
  }

  void fitWindow(260);
  titleEl.textContent = t("progRecStartTitle");
  detailEl.textContent = t("progRecStartDetail");
  document.title = t("progRecStartTitle");
}

function render(session) {
  if (session.kind === "record") {
    renderRecording(session);
    return;
  }
  const key = JSON.stringify({
    phase: session.phase,
    current: session.current,
    total: session.total,
    copied: session.copied,
    imageCount: session.imageCount,
    error: session.error,
    warnings: session.warnings,
  });
  if (key === rendered) return;
  rendered = key;

  const phase = session.phase || "start";
  const count = session.imageCount || session.images?.length || 0;
  noteEl.hidden = true;
  actionsEl.hidden = true;
  actionsEl.replaceChildren();
  trackEl.hidden = phase !== "scroll";
  const capturing = session.status === "capturing" && (phase === "start" || phase === "scroll");
  cancelRowEl.hidden = !capturing;

  const tall = phase === "multi" || phase === "manual" || phase === "error" || session.status === "error";
  void fitWindow(tall ? 340 : capturing ? 300 : 260);

  if (phase === "cancelled") {
    markSteps("cancelled");
    titleEl.textContent = t("progCancelledTitle");
    detailEl.textContent = t("progCancelledDetail");
    document.title = t("progCancelledTitle");
    closeLater(CANCEL_CLOSE_MS);
    return;
  }

  if (phase === "error" || session.status === "error") {
    markSteps("start");
    titleEl.textContent = t("progErrorTitle");
    detailEl.textContent = session.error || t("tryAgain");
    actionsEl.hidden = false;
    actionsEl.append(button(t("close"), () => window.close(), true));
    document.title = t("progErrorTitle");
    closeLater(ERROR_CLOSE_MS);
    return;
  }

  if (phase === "manual") {
    markSteps("copy");
    titleEl.textContent = t("progManualTitle");
    detailEl.textContent = t("progManualDetail");
    actionsEl.hidden = false;
    actionsEl.append(button(t("copyImage"), () => void copyStored(0).catch(() => {
      detailEl.textContent = t("progCopyRetry");
    })));
    document.title = t("progManualTitle");
    return;
  }

  if (phase === "multi") {
    markSteps("done");
    titleEl.textContent = t("progMultiTitle");
    detailEl.textContent = t("progMultiDetail", count);
    actionsEl.hidden = false;
    for (let index = 1; index < count; index += 1) {
      const label = t("copyNth", index + 1);
      actionsEl.append(button(label, () => void copyStored(index)));
    }
    actionsEl.append(button(t("close"), () => window.close(), true));
    document.title = t("progMultiTitle");
    return;
  }

  if (phase === "done") {
    markSteps("done");
    titleEl.textContent = t("progDoneTitle");
    detailEl.textContent = t("progDoneDetail");
    document.title = t("progDoneTitle");
    if (session.warnings?.length) {
      noteEl.hidden = false;
      noteEl.textContent = session.warnings[0];
    }
    closeLater(DONE_CLOSE_MS);
    return;
  }

  if (phase === "copy") {
    markSteps("copy");
    titleEl.textContent = t("progCopyTitle");
    detailEl.textContent = t("progCopyDetail");
    document.title = t("progCopyTitle");
    return;
  }

  if (phase === "scroll") {
    markSteps("scroll");
    titleEl.textContent = t("progScrollTitle");
    const progress = session.total ? `${session.current} / ${session.total}` : `${session.current || 0}`;
    detailEl.textContent = cancelling ? t("progCancelling") : progress;
    const ratio = session.total ? Math.min(1, session.current / session.total) : 0;
    barEl.style.width = `${Math.round(ratio * 100)}%`;
    document.title = t("actionTitleBusy", progress);
    return;
  }

  markSteps("start");
  titleEl.textContent = t("progStartTitle");
  detailEl.textContent = cancelling ? t("progCancelling") : t("progStartDetail");
  document.title = t("progStartTitle");
}

async function poll() {
  try {
    if (!sessionId) {
      titleEl.textContent = t("progErrorTitle");
      detailEl.textContent = t("progNoSession");
      closeLater(ERROR_CLOSE_MS);
      return;
    }
    const session = await getSession(sessionId);
    if (session) render(session);
  } catch (error) {
    console.error(error);
  }
  window.setTimeout(() => void poll(), 200);
}

cancelButton.addEventListener("click", () => {
  if (cancelling) return;
  cancelling = true;
  cancelButton.disabled = true;
  detailEl.textContent = recordMode ? t("progRecStopping") : t("progCancelling");
  const type = recordMode ? "stop" : "cancel";
  void chrome.runtime.sendMessage({ target: "background", type, sessionId }).catch(() => {});
});

window.setInterval(showElapsed, 500);

document.querySelector("#settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.connect({ name: "keepalive" });
void poll();
