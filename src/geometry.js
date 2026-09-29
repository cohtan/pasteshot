export const MAX_TILES = 24;
export const MAX_OUT_WIDTH = 1280;
export const MAX_OUT_HEIGHT = 7200;

export function scrollStops(content, viewport) {
  const view = Math.max(1, Math.round(viewport));
  const total = Math.max(view, Math.round(content));
  const max = total - view;
  if (max <= 0) return [0];
  const stops = [];
  for (let pos = 0; pos < max; pos += view) stops.push(pos);
  if (stops[stops.length - 1] !== max) stops.push(max);
  return stops;
}

export function uniqueSorted(values) {
  return [...new Set(values.map((value) => Math.round(value)))].sort((a, b) => a - b);
}

export function placementsFromStops(stops, viewport, content) {
  const view = Math.max(1, viewport);
  const endAll = Math.max(view, content);
  return [...stops]
    .sort((a, b) => a - b)
    .map((start, index, sorted) => {
      const next = index + 1 < sorted.length ? sorted[index + 1] : endAll;
      const span = Math.max(0, Math.min(view, next - start));
      return {
        scroll: start,
        srcStart: 0,
        srcSpan: span,
        destStart: start,
        destSpan: span,
      };
    })
    .filter((place) => place.destSpan > 0);
}

export function outputSlices(pageWidth, pageHeight, limits = {}) {
  const maxWidth = limits.maxWidth ?? MAX_OUT_WIDTH;
  const maxHeight = limits.maxHeight ?? MAX_OUT_HEIGHT;
  const pixelRatio = limits.pixelRatio ?? 1;
  const safeWidth = Math.max(1, pageWidth);
  const safeHeight = Math.max(1, pageHeight);
  const scale = Math.min(pixelRatio, maxWidth / safeWidth);
  const width = Math.max(1, Math.round(safeWidth * scale));
  const height = Math.max(1, Math.round(safeHeight * scale));
  const slices = [];
  for (let destY = 0; destY < height; ) {
    const destH = Math.min(maxHeight, height - destY);
    slices.push({ destY, destH });
    destY += destH;
  }
  return { scale, width, height, slices };
}

function framePieces(meta, frameIndex) {
  const crop = meta.crop;
  const right = Math.max(0, meta.viewportWidth - crop.x - crop.width);
  const below = Math.max(0, meta.viewportHeight - crop.y - crop.height);
  const pieces = [];
  if (crop.y > 0) {
    pieces.push({
      index: frameIndex,
      src: { x: 0, y: 0, w: meta.viewportWidth, h: crop.y },
      dest: { x: 0, y: 0, w: meta.viewportWidth, h: crop.y },
    });
  }
  if (below > 0) {
    pieces.push({
      index: frameIndex,
      src: { x: 0, y: crop.y + crop.height, w: meta.viewportWidth, h: below },
      dest: { x: 0, y: crop.y + meta.contentHeight, w: meta.viewportWidth, h: below },
    });
  }
  if (crop.x > 0) {
    pieces.push({
      index: frameIndex,
      src: { x: 0, y: crop.y, w: crop.x, h: crop.height },
      dest: { x: 0, y: crop.y, w: crop.x, h: crop.height },
    });
  }
  if (right > 0) {
    pieces.push({
      index: frameIndex,
      src: { x: crop.x + crop.width, y: crop.y, w: right, h: crop.height },
      dest: {
        x: crop.x + meta.contentWidth,
        y: crop.y,
        w: right,
        h: crop.height,
      },
    });
  }
  return pieces;
}

export function pageWidth(meta) {
  const crop = meta.crop;
  const right = Math.max(0, meta.viewportWidth - crop.x - crop.width);
  return Math.round(crop.x + meta.contentWidth + right);
}

export function planPage(meta, tiles) {
  const crop = meta.crop;
  const below = Math.max(0, meta.viewportHeight - crop.y - crop.height);
  const outputWidth = pageWidth(meta);
  const outputHeight = Math.round(crop.y + meta.contentHeight + below);
  const xPlaces = placementsFromStops(uniqueSorted(tiles.map((tile) => tile.x)), crop.width, meta.contentWidth);
  const yPlaces = placementsFromStops(uniqueSorted(tiles.map((tile) => tile.y)), crop.height, meta.contentHeight);
  const xBy = new Map(xPlaces.map((place) => [place.scroll, place]));
  const yBy = new Map(yPlaces.map((place) => [place.scroll, place]));
  const placements = [];
  for (const tile of tiles) {
    const xp = xBy.get(Math.round(tile.x));
    const yp = yBy.get(Math.round(tile.y));
    if (!xp || !yp) continue;
    placements.push({
      index: tile.index,
      src: {
        x: crop.x + xp.srcStart,
        y: crop.y + yp.srcStart,
        w: xp.srcSpan,
        h: yp.srcSpan,
      },
      dest: {
        x: crop.x + xp.destStart,
        y: crop.y + yp.destStart,
        w: xp.destSpan,
        h: yp.destSpan,
      },
    });
  }
  const frameTile = tiles.find((tile) => Math.round(tile.x) === 0 && Math.round(tile.y) === 0) ?? tiles[0];
  const frame = frameTile ? framePieces(meta, frameTile.index) : [];
  return { outputWidth, outputHeight, placements, frame };
}
