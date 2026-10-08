import assert from "node:assert/strict";
import test from "node:test";
import { extensionForVideo, fileStem, formatElapsed, pickMimeType, recordingFileName, videoSize } from "../src/video.js";

test("pickMimeType prefers MP4 and falls back to WebM", () => {
  assert.equal(pickMimeType(() => true), "video/mp4;codecs=avc1");
  assert.equal(pickMimeType((type) => type.startsWith("video/webm")), "video/webm;codecs=vp9");
  assert.equal(pickMimeType(() => false), "");
});

test("extensionForVideo follows the container", () => {
  assert.equal(extensionForVideo("video/mp4;codecs=avc1"), "mp4");
  assert.equal(extensionForVideo("video/webm"), "webm");
  assert.equal(extensionForVideo(""), "webm");
});

test("videoSize keeps device pixels up to the cap and stays even", () => {
  assert.deepEqual(videoSize(1280, 720, 1), { width: 1280, height: 720 });
  assert.deepEqual(videoSize(1440, 900, 2), { width: 1920, height: 1200 });
  assert.deepEqual(videoSize(801, 601, 1), { width: 802, height: 602 });
  assert.deepEqual(videoSize(2560, 1440, 1), { width: 1920, height: 1080 });
});

test("fileStem removes characters Windows does not allow", () => {
  assert.equal(fileStem('a/b:c*d?"e<f>g|h'), "a b c d e f g h");
  assert.equal(fileStem("Title. "), "Title");
  assert.equal(fileStem(""), "page");
});

test("recordingFileName adds a local timestamp", () => {
  const date = new Date(2026, 9, 8, 9, 5, 3);
  assert.equal(recordingFileName("Help | Site", date, "video/mp4"), "Help Site 2026-10-08 09.05.03.mp4");
});

test("formatElapsed shows minutes and seconds, and hours when needed", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(65_400), "1:05");
  assert.equal(formatElapsed(3_725_000), "1:02:05");
});
