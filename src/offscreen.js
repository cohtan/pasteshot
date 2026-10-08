import { deleteTiles, getSession, tilesFor, updateSession } from "./db.js";
import { copyPng, stitch } from "./stitch.js";
import { pickMimeType, VIDEO_BITS_PER_SECOND } from "./video.js";

const KEEPALIVE_MS = 20000;

// The recording in progress: { sessionId, stream, recorder, chunks, finished, timer }.
let recording = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;
  const handlers = {
    "record-start": () => startRecording(message),
    "record-stop": () => stopRecording(message.sessionId),
  };
  const handler = handlers[message.type] || (() => finish(message.sessionId));
  void handler()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

async function finish(sessionId) {
  const session = await getSession(sessionId);
  const tiles = await tilesFor(sessionId);
  if (!session?.meta || tiles.length === 0) throw new Error("missing capture");
  const stitched = await stitch(session.meta, tiles);
  await updateSession(sessionId, { images: stitched.images });
  await deleteTiles(sessionId);
  const imageCount = stitched.images.length;
  try {
    await copyPng(stitched.images[0].blob);
    return { ok: true, copied: true, method: "offscreen", imageCount };
  } catch (error) {
    return {
      ok: true,
      copied: false,
      method: "offscreen",
      imageCount,
      error: String(error?.message || error),
    };
  }
}

function tellBackground(type, sessionId) {
  return chrome.runtime.sendMessage({ target: "background", type, sessionId }).catch(() => {});
}

async function startRecording({ sessionId, streamId, width, height }) {
  if (recording) throw new Error("already recording");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: width,
        maxHeight: height,
        maxFrameRate: 30,
      },
    },
  });
  const mimeType = pickMimeType((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  });
  const chunks = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  const finished = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
  // The track ends when the recorded tab is closed.
  for (const track of stream.getVideoTracks()) {
    track.addEventListener("ended", () => void tellBackground("record-ended", sessionId), { once: true });
  }
  recorder.start(1000);
  // Messages keep the service worker awake for as long as the recording runs.
  const timer = setInterval(() => void tellBackground("record-tick", sessionId), KEEPALIVE_MS);
  recording = { sessionId, stream, recorder, chunks, finished, timer };
  return { ok: true, mimeType: recorder.mimeType || mimeType };
}

async function stopRecording(sessionId) {
  if (!recording || recording.sessionId !== sessionId) throw new Error("not recording");
  const { stream, recorder, chunks, finished, timer } = recording;
  clearInterval(timer);
  if (recorder.state !== "inactive") recorder.stop();
  await finished;
  for (const track of stream.getTracks()) track.stop();
  recording = null;
  const type = (recorder.mimeType || "video/webm").split(";")[0];
  const video = new Blob(chunks, { type });
  if (video.size === 0) throw new Error("empty recording");
  await updateSession(sessionId, { video, videoType: recorder.mimeType || type, videoSize: video.size });
  return { ok: true, type: recorder.mimeType || type, size: video.size };
}
