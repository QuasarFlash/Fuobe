import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Generation } from "@/lib/catalog/types";
import { startFakeComfy, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

// A run on a model with trained sizes (comfy.ts workflowCanvas) on a real run path: the graph gets the trained canvas, the
// run records the centre to keep (meta.cropTo), and the saved picture is cropped to the shape asked. A model without
// sizes, and a shape the model is trained at, save the picture as made.
vi.setConfig({ testTimeout: 120_000 });

const dir = tempDir("fuobe-trained-run-");
process.env.FUOBE_DATA_DIR = dir;
delete process.env.FUOBE_PASSWORD;
delete process.env.COMFYUI_WHERE;

const fake: FakeComfy = await startFakeComfy({ output: "image", delayMs: 100 });
process.env.COMFYUI_URL = fake.url;

const gens = await import("@/server/generations");
const { db } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
const { absolutePath, getAsset } = await import("@/server/storage");
const sharp = (await import("sharp")).default;

beforeAll(() => setSetting("demoMode", "off"));
afterAll(async () => {
  await fake.close();
});

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const graphs = () => fake.log.filter((e) => e.path === "/prompt" && e.prompt).map((e) => e.prompt as Graph);
const meta = (id: string) => JSON.parse((db().prepare("SELECT external_meta_json AS m FROM generations WHERE id = ?").get(id) as { m: string | null }).m ?? "{}");

async function settle(id: string, ms = 60_000): Promise<Generation> {
  const end = Date.now() + ms;
  for (;;) {
    const g = gens.getGeneration(id)!;
    if (["succeeded", "failed", "canceled"].includes(g.status)) return g;
    if (Date.now() > end) throw new Error(`timed out: ${g.status} ${g.message ?? ""}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** One run of `modelId` at a shape and tier: the canvas its graph got, what it kept to crop, and the saved picture's size. */
async function run(modelId: string, aspectRatio: string, resolution: string) {
  const before = graphs().length;
  const [g] = gens.createGenerations({ feature: "image", modelId, prompt: "a lighthouse at dusk", params: { aspectRatio, resolution } });
  const done = await settle(g.id);
  expect(done.status, done.error ?? "").toBe("succeeded");
  const latent = Object.values(graphs().slice(before)[0]).find((n) => typeof n.inputs.width === "number" && typeof n.inputs.height === "number")!;
  const asset = getAsset(done.outputs[0].assetId!)!;
  const saved = await sharp(fs.readFileSync(absolutePath(asset.relPath))).metadata();
  return { canvas: { width: latent.inputs.width, height: latent.inputs.height }, cropTo: meta(g.id).cropTo, saved: { width: saved.width, height: saved.height } };
}

describe("a run on a model with trained sizes keeps the shape asked", () => {
  it("Krea 2 Turbo at 21:9: renders 2048 × 1024 and saves the picture cropped to 21:9", async () => {
    const r = await run("oss-krea2-turbo", "21:9", "1K");
    expect(r.canvas).toEqual({ width: 2048, height: 1024 });
    expect(r.cropTo).toEqual({ width: 2048, height: 878 });
    // The stand-in ComfyUI answers a 2 × 2 picture: its centre at 21:9 is 2 × 1.
    expect(r.saved).toEqual({ width: 2, height: 1 });
  });

  it("a shape the model is trained at, and a model without sizes, save the picture as made", async () => {
    const square = await run("oss-krea2-turbo", "1:1", "1K");
    expect(square).toMatchObject({ canvas: { width: 1024, height: 1024 }, cropTo: undefined, saved: { width: 2, height: 2 } });
    const plain = await run("oss-z-image-turbo", "21:9", "1K");
    expect(plain.cropTo).toBeUndefined();
    expect(plain.saved).toEqual({ width: 2, height: 2 });
  });
});
