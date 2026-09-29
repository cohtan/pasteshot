import { deleteTiles, getSession, tilesFor, updateSession } from "./db.js";
import { copyPng, stitch } from "./stitch.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;
  void finish(message.sessionId)
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
