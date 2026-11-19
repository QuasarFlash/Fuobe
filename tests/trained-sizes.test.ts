import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GenInput, Operation } from "@/lib/catalog/types";
import type { Manifest, ManifestWorkflow } from "@/lib/comfy";
import { tempDir } from "./helpers/temp-dir";

/**
 * Trained canvases (a workflow's manifest `sizes`, comfy.ts workflowCanvas): a model with a table renders the trained size
 * nearest the shape asked, a tier past its range takes its nearest trained size, and a result whose shape isn't the one
 * asked is cropped to it once saved (crop-picture.ts cropSavedToRatio). The composer, the run's size for limits and
 * prices, and the saved picture agree; a workflow without `sizes` renders what it always did.
 */
const dir = tempDir("fuobe-trained-sizes-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const { computeDimensions, cropToRatio, trainedDimensions, workflowCanvas } = await import("@/lib/comfy");
const { prepareWorkflow } = await import("@/server/providers/comfyui");
const { requestMegapixels } = await import("@/server/hosted");
const { getModel } = await import("@/lib/catalog");
const { SPEC } = await import("../scripts/comfy/library.spec.mjs");
const { absolutePath, getAsset, saveFile } = await import("@/server/storage");
const { askedCrop, cropSavedToRatio } = await import("@/server/crop-picture");
const sharp = (await import("sharp")).default;

const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "workflows/comfyui/manifest.json"), "utf8")) as Manifest;
const entry = (id: string) => manifest.workflows.find((w) => w.id === id)!;
const RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9", "5:4", "4:5"];
const TIERS = [undefined, "0.5K", "1K", "1MP", "1.5K", "2K", "4K"];
const ratioOf = (r: string) => r.split(":").map(Number).reduce((a, b) => a / b);

/** [width, height] it renders, then the crop it keeps (none: the canvas has the shape asked). */
type Want = [number, number] | [number, number, number, number];
const canvas = (id: string, ratio: string, tier?: string): Want => {
  const c = workflowCanvas(entry(id), ratio, tier);
  return c.crop ? [c.width, c.height, c.crop.width, c.crop.height] : [c.width, c.height];
};

const QWEN21 = ["qwen-image-21-t2i", "qwen-image-21-t2i-small", "qwen-image-21-t2i-draft", "qwen-image-21-t2i-fast", "qwen-image-21-t2i-details"];
const KREA2 = ["krea2-realism-t2i", "krea2-turbo-t2i", "krea2-edit-general", "krea2-edit-identity", "style-ref-krea2"];
const FLUX1 = ["flux1-dev-t2i", "flux1-krea-dev-t2i", "flux1-schnell-t2i", "style-ref-uso-flux1"];

describe("trained size tables in the manifest", () => {
  const tabled = manifest.workflows.filter((w) => w.sizes);

  it("are the models with verified sizes, and only those", () => {
    expect(tabled.map((w) => w.id).sort()).toEqual(
      [...QWEN21, ...KREA2, ...FLUX1, "qwen-image-2512-t2i", "qwen-image-2512-t2i-lightning", "hidream-i1-dev-t2i", "sdxl-t2i", "minimax-h3-image-t2i", "minimax-h3-image-t2i-fast"].sort(),
    );
    // No verified guidance yet: unchanged.
    for (const id of ["flux3-klein-t2i", "style-ref-flux2-klein-4b", "style-ref-qwen-edit-2511", "z-image-turbo-t2i", "moss-image-t2i", "ideogram4-t2i", "flux2-dev-t2i"]) {
      expect(entry(id)?.sizes, id).toBeUndefined();
    }
  });

  it.each(tabled.map((w) => [w.id, w] as const))("%s: each size on the graph's grid and inside its limits, both orientations, as library.spec says", (id, w) => {
    const spec = (SPEC as { id: string; sizes?: unknown }[]).find((s) => s.id === id);
    expect(w.sizes).toEqual(spec?.sizes);
    expect(w.bindings.width && w.bindings.height, id).toBeTruthy();
    const m = Number(w.limits?.dimensionMultiple ?? 16);
    for (const [tier, list] of Object.entries(w.sizes!.tiers ?? {})) {
      expect(list.length, tier).toBeGreaterThan(0);
      for (const [width, height] of list) {
        expect(width % m || height % m, `${id} ${tier} ${width}x${height}`).toBe(0);
        expect(width <= Number(w.limits?.maxWidth ?? Infinity) && height <= Number(w.limits?.maxHeight ?? Infinity), `${id} ${tier} ${width}x${height}`).toBe(true);
        expect(list.some(([a, b]) => a === height && b === width), `${id} ${tier} ${height}x${width}`).toBe(true);
      }
    }
    const s = w.sizes!;
    if (s.minSide && s.maxSide) expect(s.minSide).toBeLessThan(s.maxSide);
  });
});

describe("the canvas each model renders", () => {
  it("Qwen-Image 2.1 (every route of its text to image): its native shapes at about 1, 2.3 and 4 MP; 21:9 and 5:4 render the nearest and crop", () => {
    for (const id of QWEN21) {
      expect(entry(id).limits).toMatchObject({ maxWidth: 2752, maxHeight: 2752, dimensionMultiple: 32 });
      expect(["1:1", "16:9", "21:9", "9:16", "4:3", "3:2", "5:4"].map((r) => canvas(id, r, "2K")), id).toEqual([
        [2048, 2048],
        [2752, 1536],
        [2752, 1536, 2752, 1179],
        [1536, 2752],
        [2400, 1792],
        [2528, 1696],
        [2400, 1792, 2240, 1792],
      ]);
      expect(["1:1", "16:9", "21:9", "4:3", "3:2"].map((r) => canvas(id, r, "1.5K")), id).toEqual([[1536, 1536], [2048, 1152], [2048, 1152, 2048, 878], [1760, 1312], [1856, 1248]]);
      expect(["1:1", "16:9", "21:9", "4:3", "3:2"].map((r) => canvas(id, r, "1K")), id).toEqual([[1024, 1024], [1376, 768], [1376, 768, 1376, 590], [1152, 864], [1248, 832]]);
    }
    // Its default (1K, 1:1) is what it always was.
    expect(getModel("oss-qwen-image-21")!.defaults).toMatchObject({ aspectRatio: "1:1", resolution: "1K" });
    expect(canvas("qwen-image-21-t2i", "1:1", "1K")).toEqual([1024, 1024]);
  });

  it("Qwen-Image 2512 and its Lightning: the model card's sizes at 1K, and 1.5K clamps to them", () => {
    for (const id of ["qwen-image-2512-t2i", "qwen-image-2512-t2i-lightning"]) {
      for (const tier of ["1K", "1.5K", undefined]) {
        expect(["1:1", "16:9", "9:16", "4:3", "3:2", "21:9"].map((r) => canvas(id, r, tier)), `${id} ${tier}`).toEqual([
          [1328, 1328],
          [1664, 928],
          [928, 1664],
          [1472, 1104],
          [1584, 1056],
          [1664, 928, 1664, 713],
        ]);
      }
    }
  });

  it("HiDream I1 and SDXL: their 1 MP buckets; SDXL's shapes are near the ratios asked, so most crop a little", () => {
    expect(["1:1", "16:9", "4:3", "3:2", "21:9"].map((r) => canvas("hidream-i1-dev-t2i", r))).toEqual([[1024, 1024], [1360, 768], [1168, 880], [1248, 832], [1360, 768, 1360, 583]]);
    expect(["1:1", "16:9", "9:16", "4:3", "5:4", "3:2", "21:9"].map((r) => canvas("sdxl-t2i", r))).toEqual([
      [1024, 1024],
      [1344, 768, 1344, 756],
      [768, 1344, 756, 1344],
      [1152, 896, 1152, 864],
      [1152, 896, 1120, 896],
      [1216, 832, 1216, 811],
      [1536, 640, 1493, 640],
    ]);
  });

  it("MiniMax H3 Image: 2K and 4K as before for the shapes its card lists; others render the nearest and crop; its default stays 2K", () => {
    const before = (r: string, tier: string) => computeDimensions(r, tier, { width: 2048, height: 2048 }, 32);
    for (const tier of ["2K", "4K"]) {
      for (const r of ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9"]) {
        const { width, height } = before(r, tier);
        expect(canvas("minimax-h3-image-t2i", r, tier), `${tier} ${r}`).toEqual([width, height]);
      }
    }
    expect(["1:1", "16:9", "21:9"].map((r) => canvas("minimax-h3-image-t2i", r, "4K"))).toEqual([[4096, 4096], [5472, 3072], [6272, 2688]]);
    expect(canvas("minimax-h3-image-t2i", "5:4", "4K")).toEqual([4736, 3552, 4440, 3552]);
    expect(canvas("minimax-h3-image-t2i", "4:5", "2K")).toEqual([1760, 2368, 1760, 2200]);
    // A tier it isn't trained at takes the nearest one it is.
    expect(canvas("minimax-h3-image-t2i", "1:1", "1K")).toEqual([2048, 2048]);
    expect(getModel("oss-minimax-h3-image")!.defaults).toMatchObject({ resolution: "2K" });
  });

  it("Krea 2: the shorter side never under 1024 and the longer never past 2048; 21:9 renders 2:1 and crops", () => {
    for (const id of KREA2) {
      expect(["1:1", "16:9", "9:16", "21:9", "4:3"].map((r) => canvas(id, r, "1K")), id).toEqual([[1024, 1024], [1824, 1024], [1024, 1824], [2048, 1024, 2048, 878], [1360, 1024]]);
      expect(["1:1", "16:9", "21:9"].map((r) => canvas(id, r, "1.5K")), id).toEqual([[1536, 1536], [2048, 1152], [2048, 1024, 2048, 878]]);
      expect(["1:1", "16:9", "21:9"].map((r) => canvas(id, r, "2K")), id).toEqual([[2048, 2048], [2048, 1152], [2048, 1024, 2048, 878]]);
      for (const r of RATIOS) {
        for (const tier of TIERS) {
          const c = workflowCanvas(entry(id), r, tier);
          expect(Math.min(c.width, c.height), `${id} ${r} ${tier}`).toBeGreaterThanOrEqual(1024);
          expect(Math.max(c.width, c.height), `${id} ${r} ${tier}`).toBeLessThanOrEqual(2048);
        }
      }
    }
  });

  it("FLUX.1: as before up to about 2 MP; 1.5K clamps to its 2 MP sizes", () => {
    for (const id of FLUX1) {
      const d = entry(id).defaults;
      for (const r of RATIOS) {
        const { width, height } = computeDimensions(r, "1K", { width: Number(d.width), height: Number(d.height) }, 16);
        expect(canvas(id, r, "1K"), `${id} ${r}`).toEqual([width, height]);
      }
      expect(["1:1", "16:9", "9:16", "3:2"].map((r) => canvas(id, r, "1.5K")), id).toEqual([[1408, 1408], [1888, 1056], [1056, 1888], [1728, 1152]]);
      // 2 MP at 21:9 is 2160 wide, past the graph's 2048: scaled down whole, then cropped back to 21:9.
      expect(canvas(id, "21:9", "1.5K")).toEqual([2048, 864, 2016, 864]);
      for (const r of RATIOS) {
        const c = workflowCanvas(entry(id), r, "1.5K");
        expect(c.width * c.height, `${id} ${r}`).toBeLessThanOrEqual(2.02e6);
      }
    }
  });

  it("a workflow without sizes renders exactly what it did before, never cropped", () => {
    const before = (w: ManifestWorkflow, r: string | undefined, tier: string | undefined) => {
      const m = Number(w.limits?.dimensionMultiple ?? 16);
      const dims = computeDimensions(r, tier, { width: Number(w.defaults?.width ?? 1024), height: Number(w.defaults?.height ?? 1024) }, m);
      const k = Math.min(1, Number(w.limits?.maxWidth ?? Infinity) / dims.width, Number(w.limits?.maxHeight ?? Infinity) / dims.height);
      return { width: Math.max(m, Math.floor((dims.width * k) / m) * m), height: Math.max(m, Math.floor((dims.height * k) / m) * m) };
    };
    const plain = manifest.workflows.filter((w) => !w.sizes && (w.bindings.width || w.bindings.height));
    expect(plain.length).toBeGreaterThan(50);
    for (const w of plain) {
      for (const r of [undefined, "1:1", "16:9", "9:16", "21:9", "5:4", "2.39:1", "1920:1080"]) {
        for (const tier of [...TIERS, "720p", "1080p"]) expect(workflowCanvas(w, r, tier), `${w.id} ${r} ${tier}`).toEqual(before(w, r, tier));
      }
    }
  });
});

describe("nearest shape and crop math", () => {
  it("the crop is the largest centre of the canvas with the ratio asked; within 1% is that ratio already", () => {
    expect(cropToRatio(2752, 1536, 21 / 9)).toEqual({ width: 2752, height: 1179 });
    expect(cropToRatio(1536, 2752, 9 / 21)).toEqual({ width: 1179, height: 2752 });
    expect(cropToRatio(2400, 1792, 5 / 4)).toEqual({ width: 2240, height: 1792 });
    expect(cropToRatio(2048, 1024, 21 / 9)).toEqual({ width: 2048, height: 878 });
    // The grid's own rounding is no crop: 1376 × 768 is 16:9 within 0.8%.
    expect(cropToRatio(1376, 768, 16 / 9)).toBeUndefined();
    expect(cropToRatio(2048, 2048, 1)).toBeUndefined();
    expect(cropToRatio(0, 10, 1)).toBeUndefined();
    // What a crop costs: the pixels outside the centre kept.
    const cost = (w: number, h: number, r: number) => {
      const c = cropToRatio(w, h, r)!;
      return Math.round((1 - (c.width * c.height) / (w * h)) * 1000) / 10;
    };
    expect(cost(2752, 1536, 21 / 9)).toBe(23.2);
    expect(cost(2048, 1024, 21 / 9)).toBe(14.3);
    expect(cost(4736, 3552, 5 / 4)).toBe(6.3);
    expect(cost(1344, 768, 16 / 9)).toBe(1.6);
  });

  it("picks the listed size of the nearest shape, and the listed tier nearest by area when the one asked isn't listed", () => {
    const sizes = { tiers: { "1K": [[1024, 1024], [1344, 768], [768, 1344]] as [number, number][], "2K": [[2048, 2048], [2688, 1536], [1536, 2688]] as [number, number][] } };
    const d = { width: 1024, height: 1024 };
    expect(trainedDimensions(sizes, 16 / 9, "1K", d)).toEqual({ width: 1344, height: 768 });
    expect(trainedDimensions(sizes, 21 / 9, "2K", d)).toEqual({ width: 2688, height: 1536 });
    expect(trainedDimensions(sizes, 9 / 16, "2K", d)).toEqual({ width: 1536, height: 2688 });
    expect(trainedDimensions(sizes, 5 / 4, "1K", d)).toEqual({ width: 1024, height: 1024 });
    expect(trainedDimensions(sizes, 4 / 3, "1K", d)).toEqual({ width: 1344, height: 768 });
    expect(trainedDimensions(sizes, 1, "1.5K", d)).toEqual({ width: 2048, height: 2048 });
    expect(trainedDimensions(sizes, 1, "0.5K", d)).toEqual({ width: 1024, height: 1024 });
    expect(trainedDimensions(sizes, 1, "4K", d)).toEqual({ width: 2048, height: 2048 });
    // No tier: the workflow's default area.
    expect(trainedDimensions(sizes, 1, undefined, { width: 2048, height: 2048 })).toEqual({ width: 2048, height: 2048 });
    // A range the canvas is inside already, or no sizes: computeDimensions decides.
    expect(trainedDimensions({ minSide: 512, maxSide: 4096 }, 16 / 9, "1K", d)).toBeNull();
    expect(trainedDimensions({ maxMegapixels: 2 }, 1, "1K", d)).toBeNull();
    expect(trainedDimensions(undefined, 1, "1K", d)).toBeNull();
  });
});

describe("every caller agrees on the canvas", () => {
  const MEDIA: Record<string, { width: number; height: number }> = { "wide.png": { width: 3000, height: 1000 } };
  const prepare = (id: string, input: GenInput, op: Operation) =>
    prepareWorkflow(id, { seed: 7, prompt: "a lighthouse at dusk", ...input }, { generationId: "g", op, upload: async (_d, _t, name) => `up_${name}`, media: ((name: string) => MEDIA[name]) as never });
  const bound = (w: ManifestWorkflow, wf: Record<string, { inputs: Record<string, unknown> }>) => ({
    width: wf[w.bindings.width![0].node].inputs[w.bindings.width![0].input],
    height: wf[w.bindings.height![0].node].inputs[w.bindings.height![0].input],
  });
  const CASES: [string, string, string, string | undefined][] = [
    ["oss-qwen-image-21", "qwen-image-21-t2i", "21:9", "2K"],
    ["oss-qwen-image-21", "qwen-image-21-t2i", "16:9", "1.5K"],
    ["oss-qwen-image", "qwen-image-2512-t2i", "21:9", "1.5K"],
    ["oss-hidream", "hidream-i1-dev-t2i", "16:9", undefined],
    ["oss-sdxl", "sdxl-t2i", "4:3", undefined],
    ["oss-minimax-h3-image", "minimax-h3-image-t2i", "5:4", "4K"],
    ["oss-krea2-realism", "krea2-realism-t2i", "21:9", "1.5K"],
    ["oss-flux1-dev", "flux1-dev-t2i", "1:1", "1.5K"],
    ["oss-z-image-turbo", "z-image-turbo-t2i", "21:9", "1.5K"],
  ];

  it.each(CASES)("%s (%s) at %s %s: the graph, the run's size and the crop it saves", async (modelId, id, aspectRatio, resolution) => {
    const model = getModel(modelId);
    expect(model?.routes.some((r) => r.endpoint === id), `${modelId} → ${id}`).toBe(true);
    const want = workflowCanvas(entry(id), aspectRatio, resolution);
    const p = await prepare(id, { aspectRatio, resolution }, "t2i");
    expect(bound(entry(id), p.workflow as never)).toEqual({ width: want.width, height: want.height });
    expect(p.meta.cropTo).toEqual(want.crop);
    expect(p.size.megapixels).toBeCloseTo((want.width * want.height) / 1e6, 2);
    const req = { modelId, feature: "image", prompt: "x", params: { aspectRatio, resolution } };
    expect(requestMegapixels(req as never, "image", modelId, id)).toBe(Math.round((want.width * want.height) / 10_000) / 100);
    if (entry(id).sizes) expect(want.crop ?? null, "a table that has this shape crops nothing").toEqual(cropToRatio(want.width, want.height, ratioOf(aspectRatio)) ?? null);
    else expect(want.crop).toBeUndefined();
  });

  it("a canvas the request names is rendered as named, never cropped; 'auto' on Krea 2 Edit keeps the photo's shape", async () => {
    const named = await prepare("qwen-image-21-t2i", { aspectRatio: "21:9", resolution: "2K", extra: { width: 1280, height: 720 } }, "t2i");
    expect(bound(entry("qwen-image-21-t2i"), named.workflow as never)).toEqual({ width: 1280, height: 736 });
    expect(named.meta.cropTo).toBeUndefined();
    const edit = await prepare("krea2-edit-general", { aspectRatio: "auto", resolution: "1K", images: ["wide.png"] }, "edit");
    // 3:1 inside 1024-2048 renders 2048 × 1024 and keeps the photo's 3:1.
    expect(bound(entry("krea2-edit-general"), edit.workflow as never)).toEqual({ width: 2048, height: 1024 });
    expect(edit.meta.cropTo).toEqual({ width: 2048, height: 683 });
  });
});

describe("the saved picture is cropped to the shape asked", () => {
  const save = async (width: number, height: number, format: "png" | "jpeg") => {
    const img = sharp({ create: { width, height, channels: 3, background: "#468" } });
    const data = await (format === "png" ? img.png() : img.jpeg()).toBuffer();
    const asset = saveFile({ data, contentType: `image/${format}`, source: "generation", generationId: "g" });
    return { url: asset.url, kind: "image" as const, contentType: asset.contentType, assetId: asset.id };
  };
  const onDisk = async (id: string) => {
    const a = getAsset(id)!;
    const meta = await sharp(fs.readFileSync(absolutePath(a.relPath))).metadata();
    return { width: meta.width, height: meta.height, format: meta.format, size: a.size, bytes: fs.statSync(absolutePath(a.relPath)).size };
  };

  it("crops a PNG and a JPEG in place, centred, in their own format; the file's recorded size follows", async () => {
    const png = await save(2752, 1536, "png");
    const out = await cropSavedToRatio(png, { width: 2752, height: 1179 });
    expect(out).toEqual(png);
    const now = await onDisk(png.assetId);
    expect(now).toMatchObject({ width: 2752, height: 1179, format: "png" });
    expect(now.size).toBe(now.bytes);
    const jpeg = await save(2400, 1792, "jpeg");
    await cropSavedToRatio(jpeg, { width: 2240, height: 1792 });
    expect(await onDisk(jpeg.assetId)).toMatchObject({ width: 2240, height: 1792, format: "jpeg" });
  });

  it("leaves a picture that has the shape already, a video and a file that's gone as they are", async () => {
    const square = await save(1024, 1024, "png");
    const before = fs.readFileSync(absolutePath(getAsset(square.assetId)!.relPath));
    await cropSavedToRatio(square, { width: 1024, height: 1024 });
    expect(fs.readFileSync(absolutePath(getAsset(square.assetId)!.relPath)).equals(before)).toBe(true);
    const clip = { url: "/api/files/x.mp4", kind: "video" as const, assetId: square.assetId };
    expect(await cropSavedToRatio(clip, { width: 21, height: 9 })).toBe(clip);
    const gone = { url: "/api/files/y.png", kind: "image" as const, assetId: "nope" };
    expect(await cropSavedToRatio(gone, { width: 21, height: 9 })).toBe(gone);
  });

  it("reads the crop a run's composer named, and nothing else", () => {
    expect(askedCrop({ cropTo: { width: 2752, height: 1179 } })).toEqual({ width: 2752, height: 1179 });
    expect(askedCrop({ cropTo: { width: "2752", height: 1179 } })).toBeUndefined();
    expect(askedCrop({ cropTo: { width: 0, height: 1179 } })).toBeUndefined();
    expect(askedCrop({})).toBeUndefined();
    expect(askedCrop(undefined)).toBeUndefined();
  });
});
