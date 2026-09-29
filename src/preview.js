import { deleteTiles, getSession, tilesFor, updateSession } from "./db.js";
import { pageWidth } from "./geometry.js";
import { copyPng, stitch } from "./stitch.js";
import { resolutionById } from "./settings.js";

const params = new URLSearchParams(location.search);
const sessionId = params.get("id");
const titleEl = document.querySelector("#title");
const sourceEl = document.querySelector("#source");
const statusEl = document.querySelector("#status");
const notesEl = document.querySelector("#notes");
const sheetsEl = document.querySelector("#sheets");
const actionsEl = document.querySelector("#actions");
const copyButton = document.querySelector("#copy");
const saveLink = document.querySelector("#save");

let images = [];
let started = false;
let pollTimer = 0;

chrome.runtime.connect({ name: "keepalive" });

function fileStem(title) {
  const stem = (title || "page").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return stem || "page";
}

function extensionFor(type) {
  return type === "image/png" ? "png" : "jpg";
}

async function copyBlob(blob) {
  await copyPng(blob);
}

function setStatus(text) {
  statusEl.textContent = text;
}

function showNotes(messages, kind) {
  notesEl.replaceChildren();
  for (const message of messages) {
    const note = document.createElement("p");
    note.className = kind;
    note.textContent = message;
    notesEl.append(note);
  }
}

function renderSource(session) {
  sourceEl.replaceChildren();
  if (!session.url) return;
  if (/^(https?|file):/i.test(session.url)) {
    const link = document.createElement("a");
    link.href = session.url;
    link.textContent = session.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    sourceEl.append(link);
    return;
  }
  sourceEl.textContent = session.url;
}

function displayImages(session, built) {
  images = built;
  sheetsEl.replaceChildren();
  const many = built.length > 1;
  copyButton.textContent = many ? "1枚目をコピー" : "画像をコピー";
  actionsEl.hidden = false;
  const firstUrl = URL.createObjectURL(built[0].blob);
  saveLink.href = firstUrl;
  saveLink.download = `${fileStem(session.title)}.${extensionFor(built[0].type)}`;
  if (many) saveLink.hidden = true;

  built.forEach((image, index) => {
    const sheet = document.createElement("section");
    sheet.className = "sheet";
    const img = document.createElement("img");
    img.src = URL.createObjectURL(image.blob);
    img.alt = many ? `${index + 1}枚目` : "ページ全体の画像";
    img.tabIndex = 0;
    img.title = "クリックでコピー";
    img.addEventListener("click", () => void copyImage(index));
    sheet.append(img);
    if (many) {
      const caption = document.createElement("p");
      caption.textContent = `${index + 1} / ${built.length}`;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${index + 1}枚目をコピー`;
      button.addEventListener("click", () => void copyImage(index));
      const link = document.createElement("a");
      link.className = "quiet";
      link.href = img.src;
      link.download = `${fileStem(session.title)}-${index + 1}.${extensionFor(image.type)}`;
      link.textContent = "ダウンロード";
      sheet.append(caption, button, link);
    }
    sheetsEl.append(sheet);
  });

  const notes = [...(session.warnings || [])];
  if (built.length > 1) notes.push("ページが長いので複数の画像に分けています。上から順に貼ってください。");
  const preset = resolutionById(session.meta?.resolution);
  if (preset.sharp) notes.push("高精細で書き出しています。画像は大きめです。");
  else if (session.meta && pageWidth(session.meta) > preset.maxWidth) notes.push("チャットに貼りやすいよう、横幅を縮めています。");
  showNotes(notes, "note");
  setStatus(many ? "必要な画像をコピーして、チャット欄に貼り付けてください。" : "画像をコピーして、チャット欄に貼り付けてください。");
  globalThis.__capture = {
    meta: session.meta,
    images: built.map((image) => ({ width: image.width, height: image.height, type: image.type })),
  };
  copyButton.focus();
}

async function copyImage(index) {
  const image = images[index];
  if (!image) return;
  try {
    await copyBlob(image.blob);
    const which = images.length > 1 ? `${index + 1}枚目をコピーしました。` : "画像をコピーしました。";
    setStatus(`${which}チャット欄に貼り付けてください。`);
  } catch (error) {
    console.error(error);
    setStatus("コピーできませんでした。画像を右クリックしてコピーするか、ダウンロードしてください。");
  }
}

async function present(session) {
  titleEl.textContent = session.title || "ページの画像";
  document.title = session.title ? `${session.title} — ページの画像` : "ページの画像";
  renderSource(session);
  if (session.status === "error") {
    setStatus(session.error || "撮影できませんでした。");
    showNotes([], "note");
    return;
  }
  if (session.status === "capturing") {
    const progress = session.total ? `（${session.current} / ${session.total}）` : session.current ? `（${session.current}）` : "";
    titleEl.textContent = "撮影しています";
    setStatus(`ページをスクロールしながら撮影しています${progress}。終わるまで、撮影中のタブは前面のままにしてください。`);
    return;
  }
  if (session.status !== "ready" || started) return;
  started = true;
  try {
    if (session.images?.length) {
      displayImages(session, session.images);
      return;
    }
    const tiles = await tilesFor(session.id);
    if (!session.meta || tiles.length === 0) throw new Error("missing capture");
    const stitched = await stitch(session.meta, tiles);
    displayImages(session, stitched.images);
    await updateSession(session.id, { images: stitched.images });
    await deleteTiles(session.id);
  } catch (error) {
    console.error(error);
    started = false;
    setStatus("画像の組み立てに失敗しました。もう一度撮影してください。");
  }
}

async function poll() {
  if (!sessionId) {
    titleEl.textContent = "ページの画像";
    setStatus("ツールバーのボタンから、見ているページを撮影できます。");
    return;
  }
  const session = await getSession(sessionId);
  if (!session) {
    setStatus("撮影データが見つかりません。もう一度撮影してください。");
    return;
  }
  await present(session);
  if (session.status === "capturing") pollTimer = window.setTimeout(() => void poll(), 400);
}

copyButton.addEventListener("click", () => void copyImage(0));

document.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "c") return;
  if (document.getSelection()?.toString()) return;
  if (images.length === 0) return;
  event.preventDefault();
  const visible = [...sheetsEl.querySelectorAll(".sheet")].find((sheet) => {
    const rect = sheet.getBoundingClientRect();
    return rect.bottom > 80 && rect.top < window.innerHeight * 0.7;
  });
  const index = visible ? [...sheetsEl.children].indexOf(visible) : 0;
  void copyImage(Math.max(0, index));
});

void poll();
