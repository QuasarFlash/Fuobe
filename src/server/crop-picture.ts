import "server-only";
import fs from "node:fs";
import sharp from "sharp";
import type { OutputFile } from "@/lib/catalog/types";
import { cropToRatio } from "@/lib/comfy";
import { decodePng, encodePng } from "./png";
import { absolutePath, getAsset, rewriteAsset } from "./storage";

/** Fractional crop window: [x, y, width, height], each 0–1 of the image's dimensions. */
export type CropWindow = [x: number, y: number, w: number, h: number];

/** Whether `v` is a valid crop window (four finite numbers in 0–1). */
export function isCropWindow(v: unknown): v is CropWindow {
  return Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1);
}

/**
 * Crop a PNG image by fractional coordinates. The result is the extracted sub-region at its natural pixel
 * size (smaller than the original). An end-frame step's recipe crops the start frame before editing it,
 * so the edited end frame shows a zoomed-in portion of the scene.
 */
export function cropPicture(png: Buffer, crop: CropWindow): Buffer {
  const img = decodePng(png);
  const [fx, fy, fw, fh] = crop;
  const x = Math.max(0, Math.min(Math.round(fx * img.width), img.width - 1));
  const y = Math.max(0, Math.min(Math.round(fy * img.height), img.height - 1));
  const w = Math.max(1, Math.min(Math.round(fw * img.width), img.width - x));
  const h = Math.max(1, Math.min(Math.round(fh * img.height), img.height - y));
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcOff = ((y + row) * img.width + x) * 4;
    const dstOff = row * w * 4;
    img.data.copy(out, dstOff, srcOff, srcOff + w * 4);
  }
  return encodePng({ width: w, height: h, data: out });
}

/** The centre a run's composer asked its saved pictures to be cropped to (meta.cropTo: a size on the canvas it rendered). */
export function askedCrop(meta: Record<string, unknown> | undefined): { width: number; height: number } | undefined {
  const c = meta?.cropTo as { width?: unknown; height?: unknown } | undefined;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  return c && ok(c.width) && ok(c.height) ? { width: c.width, height: c.height } : undefined;
}

/**
 * A saved picture cropped in place to the aspect ratio of `crop` (its centre; comfy.ts cropToRatio), in the format it
 * was saved in: a model trained on other shapes renders its nearest one, and the run keeps the shape asked. A picture
 * that has that shape already (within 1%), a file that isn't a picture sharp reads, and one that is gone stay as they are.
 */
export async function cropSavedToRatio(o: OutputFile, crop: { width: number; height: number }): Promise<OutputFile> {
  if (o.kind !== "image" || !o.assetId) return o;
  const asset = getAsset(o.assetId);
  if (!asset || !/^image\/(png|jpeg|webp)$/.test(asset.contentType)) return o;
  // Read whole first: the file is written over below.
  const input = await fs.promises.readFile(absolutePath(asset.relPath)).catch(() => null);
  if (!input) return o;
  const meta = await sharp(input, { failOn: "error", limitInputPixels: 64 * 2 ** 20 }).metadata().catch(() => null);
  if (!meta?.width || !meta.height) return o;
  const box = cropToRatio(meta.width, meta.height, crop.width / crop.height);
  if (!box) return o;
  let img = sharp(input, { limitInputPixels: 64 * 2 ** 20 }).extract({ left: Math.floor((meta.width - box.width) / 2), top: Math.floor((meta.height - box.height) / 2), width: box.width, height: box.height });
  img = meta.format === "jpeg" ? img.jpeg({ quality: 95 }) : meta.format === "webp" ? img.webp({ lossless: true }) : img.png();
  const data = await img.toBuffer();
  rewriteAsset(asset.id, data);
  return { ...o, ...(o.width !== undefined && { width: box.width }), ...(o.height !== undefined && { height: box.height }) };
}
