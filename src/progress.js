import { getSession } from "./db.js";
import { localize, t } from "./i18n.js";
import { copyPng } from "./stitch.js";

localize();

const sessionId = new URLSearchParams(location.search).get("id");
const titleEl = document.querySelector("#title");
const detailEl = document.querySelector("#detail");
const noteEl = document.querySelector("#note");
const trackEl = document.querySelector("#track");
const barEl = document.querySelector("#bar");
const actionsEl = document.querySelector("#actions");
const steps = {
  start: document.querySelector("#step-start"),
  scroll: document.querySelector("#step-scroll"),
  copy: document.querySelector("#step-copy"),
};

const DONE_CLOSE_MS = 2800;
const ERROR_CLOSE_MS = 6000;

let rendered = "";
let closing = false;

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

function render(session) {
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

  const tall = phase === "multi" || phase === "manual" || phase === "error" || session.status === "error";
  void fitWindow(tall ? 340 : 260);

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
    detailEl.textContent = progress;
    const ratio = session.total ? Math.min(1, session.current / session.total) : 0;
    barEl.style.width = `${Math.round(ratio * 100)}%`;
    document.title = t("actionTitleBusy", progress);
    return;
  }

  markSteps("start");
  titleEl.textContent = t("progStartTitle");
  detailEl.textContent = t("progStartDetail");
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

document.querySelector("#settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.connect({ name: "keepalive" });
void poll();
