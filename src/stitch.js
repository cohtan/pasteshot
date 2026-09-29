import { outputSlices, planPage } from "./geometry.js";
import { outputLimits, resolutionById } from "./settings.js";

function drawPiece(ctx, bitmap, piece, bitmapScaleX, bitmapScaleY, pageScale, sliceDestY) {
  const sx = Math.round(piece.src.x * bitmapScaleX);
  const sy = Math.round(piece.src.y * bitmapScaleY);
  const sw = Math.round((piece.src.x + piece.src.w) * bitmapScaleX) - sx;
  const sh = Math.round((piece.src.y + piece.src.h) * bitmapScaleY) - sy;
  const dx = piece.dest.x * pageScale;
  const dy = piece.dest.y * pageScale - sliceDestY;
  const dw = piece.dest.w * pageScale;
  const dh = piece.dest.h * pageScale;
  if (sw < 1 || sh < 1 || dw < 0.5 || dh < 0.5) return;
  ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh);
}

export async function stitch(meta, tiles) {
  const plan = planPage(meta, tiles);
  const bitmaps = new Map();
  for (const tile of tiles) bitmaps.set(tile.index, await createImageBitmap(tile.blob));
  const sample = bitmaps.values().next().value;
  const pixelRatio = sample && meta.viewportWidth ? sample.width / meta.viewportWidth : 1;
  const limits = outputLimits(resolutionById(meta.resolution), pixelRatio);
  const slices = outputSlices(plan.outputWidth, plan.outputHeight, limits);

  const images = [];
  try {
    for (const slice of slices.slices) {
      const canvas = document.createElement("canvas");
      canvas.width = slices.width;
      canvas.height = slice.destH;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = meta.background || "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      const paint = (piece) => {
        const bitmap = bitmaps.get(piece.index);
        if (!bitmap) return;
        drawPiece(
          ctx,
          bitmap,
          piece,
          bitmap.width / meta.viewportWidth,
          bitmap.height / meta.viewportHeight,
          slices.scale,
          slice.destY,
        );
      };
      for (const piece of plan.frame) paint(piece);
      for (const piece of plan.placements) paint(piece);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("encode failed"))), "image/png");
      });
      images.push({ blob, width: canvas.width, height: canvas.height, type: "image/png" });
    }
  } finally {
    for (const bitmap of bitmaps.values()) bitmap.close();
  }
  return { plan, slices, images };
}

export async function copyPng(blob) {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
