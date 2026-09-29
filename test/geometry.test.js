import assert from "node:assert/strict";
import test from "node:test";
import { outputSlices, pageWidth, planPage, placementsFromStops, scrollStops } from "../src/geometry.js";

function coveredRows(pieces, height) {
  const rows = new Array(Math.round(height)).fill(0);
  for (const piece of pieces) {
    const start = Math.round(piece.dest.y);
    const end = Math.round(piece.dest.y + piece.dest.h);
    for (let y = start; y < end; y += 1) {
      if (y >= 0 && y < rows.length) rows[y] += 1;
    }
  }
  return rows;
}

test("scroll stops cover a partial last viewport", () => {
  assert.deepEqual(scrollStops(2716, 800), [0, 800, 1600, 1916]);
  assert.deepEqual(scrollStops(2400, 800), [0, 800, 1600]);
  assert.deepEqual(scrollStops(500, 800), [0]);
});

test("placements abut across the content", () => {
  const places = placementsFromStops([0, 800, 1600, 1916], 800, 2716);
  assert.equal(places[0].destStart, 0);
  assert.equal(places[0].destSpan, 800);
  assert.equal(places[1].destSpan, 800);
  assert.equal(places[2].destSpan, 316);
  assert.equal(places[3].destStart, 1916);
  assert.equal(places[3].destSpan, 800);
  let cursor = 0;
  for (const place of places) {
    assert.equal(place.destStart, cursor);
    cursor += place.destSpan;
  }
  assert.equal(cursor, 2716);
});

test("sharp output keeps device pixels until the width cap", () => {
  const sharp = outputSlices(1000, 2000, { maxWidth: 3840, pixelRatio: 2, maxHeight: 7200 });
  assert.equal(sharp.scale, 2);
  assert.equal(sharp.width, 2000);
  assert.equal(sharp.height, 4000);

  const capped = outputSlices(2000, 1000, { maxWidth: 1280, pixelRatio: 1, maxHeight: 7200 });
  assert.equal(capped.width, 1280);
  assert.equal(capped.height, 640);
});

test("output slices keep each piece within the paste limit", () => {
  const wide = outputSlices(2000, 1000, { maxWidth: 1280, maxHeight: 7200 });
  assert.equal(wide.width, 1280);
  assert.equal(wide.height, 640);
  assert.equal(wide.slices.length, 1);

  const tall = outputSlices(1000, 20000, { maxWidth: 1280, maxHeight: 7200 });
  assert.equal(tall.width, 1000);
  assert.equal(tall.slices.reduce((sum, slice) => sum + slice.destH, 0), tall.height);
  assert.ok(tall.slices.every((slice) => slice.destH <= 7200));
  assert.ok(tall.slices.length > 1);
});

test("window capture covers every row once", () => {
  const viewportHeight = 800;
  const contentHeight = 2716;
  const tiles = scrollStops(contentHeight, viewportHeight).map((y, index) => ({ index, x: 0, y }));
  const plan = planPage(
    {
      viewportWidth: 1000,
      viewportHeight,
      contentWidth: 1000,
      contentHeight,
      crop: { x: 0, y: 0, width: 1000, height: viewportHeight },
    },
    tiles,
  );
  assert.equal(plan.outputWidth, 1000);
  assert.equal(plan.outputHeight, contentHeight);
  assert.equal(plan.frame.length, 0);
  const rows = coveredRows(plan.placements, plan.outputHeight);
  assert.ok(rows.every((count) => count === 1));
});

test("inner scroller keeps the chrome above and below the unrolled content", () => {
  const tiles = scrollStops(2000, 700).map((y, index) => ({ index, x: 0, y }));
  const plan = planPage(
    {
      viewportWidth: 1000,
      viewportHeight: 800,
      contentWidth: 840,
      contentHeight: 2000,
      crop: { x: 160, y: 50, width: 840, height: 700 },
    },
    tiles,
  );
  assert.equal(plan.outputWidth, 1000);
  assert.equal(plan.outputHeight, 2100);
  const top = plan.frame.find((piece) => piece.dest.y === 0);
  const bottom = plan.frame.find((piece) => piece.dest.y === 2050);
  const side = plan.frame.find((piece) => piece.dest.x === 0 && piece.dest.y === 50);
  assert.equal(top.dest.h, 50);
  assert.equal(bottom.dest.h, 50);
  assert.equal(side.dest.w, 160);
  const rows = coveredRows([...plan.frame, ...plan.placements], plan.outputHeight);
  assert.ok(rows.every((count) => count >= 1));
  const contentRows = coveredRows(plan.placements, plan.outputHeight);
  assert.equal(contentRows[49], 0);
  assert.equal(contentRows[50], 1);
  assert.equal(contentRows[2049], 1);
  assert.equal(contentRows[2050], 0);
});

test("page width includes the chrome beside an inner scroller", () => {
  const meta = {
    viewportWidth: 1000,
    viewportHeight: 800,
    contentWidth: 700,
    contentHeight: 2000,
    crop: { x: 160, y: 50, width: 700, height: 700 },
  };
  assert.equal(pageWidth(meta), 1000);
  assert.equal(planPage(meta, [{ index: 0, x: 0, y: 0 }]).outputWidth, 1000);
});
