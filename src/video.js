// Recording format, size, and file name. Kept free of chrome.* so it can be tested.

export const MAX_VIDEO_EDGE = 1920;
export const VIDEO_BITS_PER_SECOND = 2_500_000;
export const MAX_RECORD_MS = 30 * 60 * 1000;

// MP4 first: it plays in the default player on Windows and macOS. WebM is
// the fallback for browsers whose MediaRecorder cannot write MP4.
const MIME_TYPES = [
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export function pickMimeType(isSupported) {
  return MIME_TYPES.find((type) => isSupported(type)) || "";
}

export function extensionForVideo(type = "") {
  return type.startsWith("video/mp4") ? "mp4" : "webm";
}

// The viewport in device pixels, scaled down so the long edge fits
// MAX_VIDEO_EDGE. H.264 needs even sizes.
export function videoSize(width, height, pixelRatio = 1) {
  const w = Math.max(2, width);
  const h = Math.max(2, height);
  const scale = Math.min(Math.max(1, pixelRatio), MAX_VIDEO_EDGE / Math.max(w, h));
  const even = (value) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(w), height: even(h) };
}

// Also drops the marks that change text direction, so a title cannot make
// the name look like it ends in another extension.
export function fileStem(title) {
  const stem = (title || "page")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return stem.replace(/[. ]+$/, "") || "page";
}

export function recordingFileName(title, date, type) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `${fileStem(title)} ${stamp}.${extensionForVideo(type)}`;
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
