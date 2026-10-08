import { deleteTiles, getSession, tilesFor, updateSession } from "./db.js";
import { pageWidth } from "./geometry.js";
import { copyPng, stitch } from "./stitch.js";
import { localize, t } from "./i18n.js";
import { resolutionById } from "./settings.js";
import { fileStem } from "./video.js";

localize();

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
  copyButton.textContent = many ? t("copyNth", 1) : t("copyImage");
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
    img.alt = many ? t("imageAltNth", index + 1) : t("imageAltPage");
    img.tabIndex = 0;
    img.title = t("clickToCopy");
    img.addEventListener("click", () => void copyImage(index));
    sheet.append(img);
    if (many) {
      const caption = document.createElement("p");
      caption.textContent = `${index + 1} / ${built.length}`;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = t("copyNth", index + 1);
      button.addEventListener("click", () => void copyImage(index));
      const link = document.createElement("a");
      link.className = "quiet";
      link.href = img.src;
      link.download = `${fileStem(session.title)}-${index + 1}.${extensionFor(image.type)}`;
      link.textContent = t("download");
      sheet.append(caption, button, link);
    }
    sheetsEl.append(sheet);
  });

  const notes = [...(session.warnings || [])];
  if (built.length > 1) notes.push(t("noteSplit"));
  const preset = resolutionById(session.meta?.resolution);
  if (preset.sharp) notes.push(t("noteSharp"));
  else if (session.meta && pageWidth(session.meta) > preset.maxWidth) notes.push(t("noteShrunk"));
  showNotes(notes, "note");
  setStatus(many ? t("statusCopyMany") : t("statusCopyOne"));
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
    setStatus(images.length > 1 ? t("copiedNthPaste", index + 1) : t("copiedImagePaste"));
  } catch (error) {
    console.error(error);
    setStatus(t("copyFailedManual"));
  }
}

async function present(session) {
  titleEl.textContent = session.title || t("previewTitle");
  document.title = session.title ? t("previewTitleWith", session.title) : t("previewTitle");
  renderSource(session);
  if (session.status === "cancelled") {
    setStatus(t("previewCancelled"));
    return;
  }
  if (session.status === "error") {
    setStatus(session.error || t("previewCaptureFailed"));
    showNotes([], "note");
    return;
  }
  if (session.status === "capturing") {
    const progress = session.total ? `${session.current} / ${session.total}` : session.current ? String(session.current) : "";
    titleEl.textContent = t("previewCapturing");
    setStatus(progress ? t("previewCapturingStatusAt", progress) : t("previewCapturingStatus"));
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
    setStatus(t("assembleFailed"));
  }
}

async function poll() {
  if (!sessionId) {
    titleEl.textContent = t("previewTitle");
    setStatus(t("previewIdle"));
    return;
  }
  const session = await getSession(sessionId);
  if (!session) {
    setStatus(t("sessionMissing"));
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
