import { getSession } from "./db.js";
import { copyPng } from "./stitch.js";

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

let rendered = "";
let closing = false;

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
    ? `${index + 1}枚目をコピーしました。チャット欄に貼り付けてください。`
    : "コピーしました。チャット欄に貼り付けてください。";
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
    titleEl.textContent = "撮影できませんでした";
    detailEl.textContent = session.error || "もう一度試してください。";
    actionsEl.hidden = false;
    actionsEl.append(button("閉じる", () => window.close(), true));
    document.title = "撮影できませんでした";
    return;
  }

  if (phase === "manual") {
    markSteps("copy");
    titleEl.textContent = "コピーボタンを押してください";
    detailEl.textContent = "自動ではコピーできませんでした。";
    actionsEl.hidden = false;
    actionsEl.append(button("画像をコピー", () => void copyStored(0).catch(() => {
      detailEl.textContent = "コピーできませんでした。もう一度押してください。";
    })));
    document.title = "コピーボタンを押してください";
    return;
  }

  if (phase === "multi") {
    markSteps("done");
    titleEl.textContent = "1枚目をコピーしました";
    detailEl.textContent = `${count}枚に分かれているので、続きはボタンからコピーしてください。`;
    actionsEl.hidden = false;
    for (let index = 1; index < count; index += 1) {
      const label = `${index + 1}枚目をコピー`;
      actionsEl.append(button(label, () => void copyStored(index)));
    }
    actionsEl.append(button("閉じる", () => window.close(), true));
    document.title = "1枚目をコピーしました";
    return;
  }

  if (phase === "done") {
    markSteps("done");
    titleEl.textContent = "コピーしました";
    detailEl.textContent = "チャット欄に貼り付けてください。";
    document.title = "コピーしました";
    if (session.warnings?.length) {
      noteEl.hidden = false;
      noteEl.textContent = session.warnings[0];
    }
    if (!closing) {
      closing = true;
      window.setTimeout(() => window.close(), 2800);
    }
    return;
  }

  if (phase === "copy") {
    markSteps("copy");
    titleEl.textContent = "コピーしています";
    detailEl.textContent = "画像をひとつにまとめています。";
    document.title = "コピーしています";
    return;
  }

  if (phase === "scroll") {
    markSteps("scroll");
    titleEl.textContent = "スクロールしています";
    const progress = session.total ? `${session.current} / ${session.total}` : `${session.current || 0}`;
    detailEl.textContent = progress;
    const ratio = session.total ? Math.min(1, session.current / session.total) : 0;
    barEl.style.width = `${Math.round(ratio * 100)}%`;
    document.title = `撮影中 ${progress}`;
    return;
  }

  markSteps("start");
  titleEl.textContent = "撮影を始めています";
  detailEl.textContent = "ページはそのままにしてください。";
  document.title = "撮影を始めています";
}

async function poll() {
  try {
    if (!sessionId) {
      titleEl.textContent = "撮影できませんでした";
      detailEl.textContent = "もう一度、ツールバーのボタンから試してください。";
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
