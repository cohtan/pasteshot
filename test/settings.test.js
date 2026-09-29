import assert from "node:assert/strict";
import test from "node:test";
import { outputLimits, resolutionById } from "../src/settings.js";

test("unknown resolution falls back to the standard preset", () => {
  const preset = resolutionById("nope");
  assert.equal(preset.id, "standard");
  assert.deepEqual(outputLimits(preset, 2), { maxWidth: 1280, pixelRatio: 1 });
});

test("sharp resolution keeps the display pixel ratio", () => {
  const preset = resolutionById("sharp");
  assert.deepEqual(outputLimits(preset, 2), { maxWidth: 3840, pixelRatio: 2 });
});

test("screen resolution stays at the page width", () => {
  const preset = resolutionById("screen");
  assert.equal(preset.sharp, false);
  assert.equal(outputLimits(preset, 2).pixelRatio, 1);
});
