import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GenInput, GenerationRequest, Operation } from "@/lib/catalog/types";
import type { ComfyWorkflow, Manifest } from "@/lib/comfy";
import { tempDir } from "./helpers/temp-dir";

/**
 * MOSS AnyPaint on your GPU: MOSS-Image Base with the AnyPaint task LoRA and the Base 8-step DMD2 LoRA, on the pinned
 * moss-anypaint nodes. One model, two graphs: Inpaint (a mask, white = generate) and Expand (the pads grow the canvas).
 */
const dir = tempDir("fuobe-moss-anypaint-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";

const { prepareWorkflow } = await import("@/server/providers/comfyui");
const { getModel, getPreset, MODELS } = await import("@/lib/catalog");
const { estimateCost, planGeneration } = await import("@/lib/catalog/plan");
const { filterModels } = await import("@/lib/composer");
const { INPAINT_STUDIO } = await import("@/lib/studios");
const { TOOL_MODELS } = await import("@/lib/layers");
const { licenceTerms, NODE_PACKS, workflowLicence } = await import("@/lib/licences");
const { modelLicence } = await import("@/server/model-access");
const { CUSTOM_NODE_REPOS, KNOWN_MODELS, PACK_CLASSES } = await import("../scripts/comfy/library.spec.mjs");
const { vetGraph } = await import("../bin/lib/worker/checks.mjs");
const { allowedNodeList, inputRules, readCatalog } = await import("../scripts/lib/worker-catalog.mjs");

const LIBRARY = path.join(process.cwd(), "workflows/comfyui");
const read = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(LIBRARY, f), "utf8")) as T;
const manifest = read<Manifest>("manifest.json");
const entry = (id: string) => manifest.workflows.find((w) => w.id === id)!;
const pins = read<Record<string, { revision: string; sizeBytes: number; sha256?: string }>>("model-pins.json");
const packs = read<Record<string, { repo: string; commit: string; registry: unknown; requirementsTxt: boolean; isolated: boolean }>>("packs.json");
const requirements = read<{ workflows: Record<string, { packs: Record<string, string[]>; files: string[]; vramGb: number; cpu?: boolean }> }>("requirements.json");
const subset = read<Record<string, { python_module: string; input: { required: Record<string, [string, ...unknown[]]>; optional?: Record<string, unknown> } } | null>>("object_info.subset.json");

const MODEL = "oss-moss-anypaint";
const INPAINT = "moss-anypaint-inpaint";
const OUTPAINT = "moss-anypaint-outpaint";
const IDS = [INPAINT, OUTPAINT];
const PACK = "moss-anypaint";
const PACK_COMMIT = "b1df126d2546acbd450f29913c56f66d59b969ae";
const CLASSES = ["MOSSAnyPaintEncode", "MOSSAnyPaintModelPatch", "MOSSAnyPaintPrepare"];

const SIZES: Record<string, { width: number; height: number }> = { "photo.png": { width: 1600, height: 1200 } };
async function prepare(id: string, input: GenInput, op: Operation): Promise<ComfyWorkflow> {
  const { workflow } = await prepareWorkflow(id, { seed: 7, ...input }, { generationId: "g", op, upload: async (_d, _t, name) => `up_${name}`, media: ((name: string) => SIZES[name]) as never });
  return workflow;
}
const plan = (r: Partial<GenerationRequest>) => planGeneration({ feature: "image", ...r } as GenerationRequest, getModel, getPreset);

describe("MOSS AnyPaint in the catalog", () => {
  const m = getModel(MODEL)!;

  it("is one open model that inpaints and expands on your GPU, free", () => {
    expect(m).toMatchObject({ engine: "open", kind: "image", vendor: "OpenMOSS", family: "moss", name: "MOSS AnyPaint" });
    expect(m.routes.map((r) => [r.op, r.provider, r.endpoint])).toEqual([
      ["inpaint", "comfyui", INPAINT],
      ["outpaint", "comfyui", OUTPAINT],
    ]);
    for (const r of m.routes) expect(entry(r.endpoint!).capability).toBe(r.op);
    // No `new`: it stays out of Inpaint's Best list while its nodes aren't on the validation server.
    expect(m.badges).toEqual(["open"]);
    expect(m.tagline).toMatch(/16 GB GPU/);
    expect(m.tagline).toMatch(/needs the MOSS AnyPaint add-on/);
    expect(m.options).toMatchObject({ maxImages: 1, seed: true });
    expect(estimateCost(m, {}, 1, "inpaint")).toBe(0);
    expect(estimateCost(m, {}, 1, "outpaint")).toBe(0);
  });

  it("is a choice in the Inpaint studio, and stays out of the Layers tools that keep the picture's own size", () => {
    expect(filterModels(MODELS, { kind: "image", ops: INPAINT_STUDIO.ops }).map((x) => x.id)).toContain(MODEL);
    expect(TOOL_MODELS.inpaint.open).not.toContain(MODEL);
    expect(TOOL_MODELS.expand.open).not.toContain(MODEL);
  });

  it("plans inpaint from a picture and a mask, expand from a picture, and asks for what's missing", () => {
    expect(plan({ modelId: MODEL, prompt: "a vase of white tulips on the table", inputs: { images: ["/a.png"], mask: "/m.png" } }).op).toBe("inpaint");
    expect(() => plan({ modelId: MODEL, prompt: "a vase", inputs: {} })).toThrow(/Add an image/);
    expect(plan({ modelId: MODEL, op: "outpaint", prompt: "the rest of the garden", inputs: { images: ["/a.png"] } }).op).toBe("outpaint");
  });
});

describe("the MOSS AnyPaint graphs", () => {
  it("Inpaint: the photo at about 1 MP, the mask's white area generated on MOSS-Image Base with both LoRAs at 1.0", async () => {
    const wf = await prepare(INPAINT, { prompt: "a sunlit kitchen with a ceramic bowl of lemons", images: ["photo.png"], mask: "mask.png" }, "inpaint");
    expect(wf["1"]).toMatchObject({ class_type: "LoadImage", inputs: { image: "photo.png" } });
    expect(wf["2"]).toMatchObject({ class_type: "LoadImageMask", inputs: { image: "mask.png", channel: "red" } });
    expect(wf["3"]).toMatchObject({ class_type: "ImageScaleToTotalPixels", inputs: { image: ["1", 0], megapixels: 1, resolution_steps: 16 } });
    expect(wf["10"].inputs.unet_name).toBe("moss_image_base_int8_convrot.safetensors");
    expect(wf["11"].inputs).toMatchObject({ clip_name: "qwen3.5_9b_int8_convrot.safetensors", type: "moss_image" });
    expect(wf["12"].inputs.vae_name).toBe("flux2-vae_small.safetensors");
    expect(wf["13"].inputs).toMatchObject({ model: ["10", 0], lora_name: "moss_anypaint_rank32.safetensors", strength_model: 1 });
    expect(wf["14"].inputs).toMatchObject({ model: ["13", 0], lora_name: "lora_dmd2.safetensors", strength_model: 1 });
    expect(wf["15"]).toMatchObject({ class_type: "MOSSAnyPaintModelPatch", inputs: { model: ["14", 0], kv_cache: true } });
    expect(wf["16"]).toMatchObject({
      class_type: "MOSSAnyPaintPrepare",
      inputs: { source: ["3", 0], generated_mask: ["2", 0], left: 0, top: 0, right: 0, bottom: 0, reference_max_edge: 384, boundary_redraw_px: 32 },
    });
    expect(wf["20"]).toMatchObject({
      class_type: "MOSSAnyPaintEncode",
      inputs: { prompt: "a sunlit kitchen with a ceramic bowl of lemons", clip: ["11", 0], vae: ["12", 0], semantic_reference: ["16", 0], known_image: ["16", 1], keep_mask: ["16", 3] },
    });
    // The card's settings: 8 steps, CFG 1 (shift 5 is core MOSS-Image's own), the known latent and its noise mask from Encode.
    expect(wf["23"]).toMatchObject({ class_type: "KSampler", inputs: { seed: 7, steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, model: ["15", 0], positive: ["20", 0], negative: ["21", 0], latent_image: ["20", 1] } });
    expect(wf["29"]).toMatchObject({ class_type: "SaveImage", inputs: { images: ["24", 0] } });
    await expect(prepare(INPAINT, { prompt: "a vase", images: ["photo.png"] }, "inpaint")).rejects.toThrow("Paint the area to change");
  });

  it("Expand: the pads asked for grow the canvas around the photo, 256 px a side by default", async () => {
    const wf = await prepare(OUTPAINT, { prompt: "the rest of the garden", images: ["photo.png"], extra: { padLeft: 128, padTop: 0, padRight: 128, padBottom: 64 } }, "outpaint");
    expect(wf["16"]).toMatchObject({ class_type: "MOSSAnyPaintPrepare", inputs: { source: ["3", 0], left: 128, top: 0, right: 128, bottom: 64 } });
    expect(wf["16"].inputs).not.toHaveProperty("generated_mask");
    expect(Object.values(wf).map((n) => n.class_type)).not.toContain("LoadImageMask");
    const plain = await prepare(OUTPAINT, { prompt: "the rest of the garden", images: ["photo.png"] }, "outpaint");
    expect(plain["16"].inputs).toMatchObject({ left: 256, top: 256, right: 256, bottom: 256 });
    expect(entry(OUTPAINT).defaults).toMatchObject({ steps: 8, padLeft: 256, padTop: 256, padRight: 256, padBottom: 256 });
    expect(entry(OUTPAINT).limits).toMatchObject({ maxWidth: 2048, maxHeight: 2048, padMultiple: 16 });
  });

  it("passes the worker's checks as the studio prepares it, and a worker refuses a LoRA it didn't verify", async () => {
    const catalog = readCatalog(process.cwd());
    const allowed = new Set(allowedNodeList(process.cwd(), catalog));
    const rules = inputRules(catalog);
    const verified = Object.values(catalog.requirements.files as Record<string, { folder: string; file: string }>).map((f) => ({ folder: f.folder, name: f.file }));
    for (const c of CLASSES) expect(allowed.has(c), c).toBe(true);
    const staged = ["fuobe_abcdefgh01.png", "fuobe_abcdefgh02.png"];
    const wf = await prepare(INPAINT, { prompt: "a vase of tulips", images: [staged[0]], mask: staged[1] }, "inpaint");
    expect(vetGraph(wf, allowed, verified, { rules, staged })).toBeNull();
    const swapped = { ...wf, "13": { ...wf["13"], inputs: { ...wf["13"].inputs, lora_name: "../../secrets.safetensors" } } };
    expect(vetGraph(swapped, allowed, verified, { rules, staged })).toBe("unsafe-path");
    const unpinned = { ...wf, "14": { ...wf["14"], inputs: { ...wf["14"].inputs, lora_name: "someone_elses_dmd2.safetensors" } } };
    expect(vetGraph(unpinned, allowed, verified, { rules, staged })).not.toBeNull();
  });
});

describe("MOSS AnyPaint files, pack and licences", () => {
  it("pins each file to a revision, its size and its SHA-256, the two LoRAs as Hugging Face lists them", () => {
    for (const id of IDS) {
      expect(entry(id).models.map((f) => `${f.folder}/${f.file}`).sort(), id).toEqual([
        "diffusion_models/moss_image_base_int8_convrot.safetensors",
        "loras/lora_dmd2.safetensors",
        "loras/moss_anypaint_rank32.safetensors",
        "text_encoders/qwen3.5_9b_int8_convrot.safetensors",
        "vae/flux2-vae_small.safetensors",
      ]);
      for (const f of entry(id).models) {
        const pin = pins[f.url!];
        expect(pin, `${id} ${f.file}`).toBeDefined();
        expect(pin.revision, f.file).toMatch(/^[0-9a-f]{40}$/);
        expect(pin.sha256, f.file).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(requirements.workflows[id].files.length, id).toBe(5);
    }
    expect(pins[KNOWN_MODELS["moss_anypaint_rank32.safetensors"].url]).toEqual({
      revision: "7edba8f26d216f5260a940c6de9e43bfa52df60f",
      sizeBytes: 148693368,
      sha256: "151701bc1a4f572bb62af22e4bc2c6db5b3a755b95c1ae93ad1a388d1ec17078",
    });
    expect(pins[KNOWN_MODELS["lora_dmd2.safetensors"].url]).toEqual({
      revision: "da05cb3b52899179e2bb5f7efe1058fefcbae21b",
      sizeBytes: 1189176800,
      sha256: "7683fe1fb51f73f5d690f24dd6b7f46f31ab9a9873729a854ac5c9a420ffe6f2",
    });
    // The Base file is the one MOSS-Image's Base setting already loads (one pin, one download).
    expect(entry("moss-image-t2i").models.find((f) => f.file === "moss_image_base_int8_convrot.safetensors")?.url).toBe(KNOWN_MODELS["moss_image_base_int8_convrot.safetensors"].url);
  });

  it("needs the moss-anypaint nodes at a pinned commit, and only their three classes", () => {
    expect(packs[PACK]).toMatchObject({ repo: "https://github.com/alexw5702-afk/moss-anypaint", commit: PACK_COMMIT, registry: null, requirementsTxt: false, isolated: false });
    expect(CUSTOM_NODE_REPOS[PACK]).toContain(PACK_COMMIT);
    for (const id of IDS) {
      expect(entry(id).customNodes.map((c) => c.name), id).toEqual([PACK]);
      expect(requirements.workflows[id].packs, id).toEqual({ [PACK]: CLASSES });
      expect(requirements.workflows[id].vramGb, id).toBe(16);
      expect(requirements.workflows[id].cpu, id).toBeUndefined();
    }
    for (const c of CLASSES) {
      expect(PACK_CLASSES[PACK].test(c), c).toBe(true);
      expect(subset[c]?.python_module, c).toBe(`custom_nodes.${PACK}`);
    }
    // No input of the pack names a file: numbers, a switch, a prompt and links.
    const kinds = CLASSES.flatMap((c) => Object.values({ ...subset[c]!.input.required, ...(subset[c]!.input.optional ?? {}) }).map((s) => (s as [string])[0]));
    expect([...new Set(kinds)].sort()).toEqual(["BOOLEAN", "CLIP", "IMAGE", "INT", "MASK", "MODEL", "STRING", "VAE"]);
    expect(subset.MOSSAnyPaintEncode!.input.required.prompt[0]).toBe("STRING");
  });

  it("records the licences as information: Apache-2.0 weights, MIT nodes", () => {
    for (const id of IDS) expect(licenceTerms(workflowLicence(entry(id))).flags, id).toEqual([]);
    expect(NODE_PACKS.find((p) => p.name === PACK)!.licence.name).toBe("MIT");
    const l = modelLicence(getModel(MODEL)!);
    expect(l.licence.name).toMatch(/Apache-2\.0/);
    expect(l.packs).toEqual([PACK]);
  });
});

describe("the GPU pre-flight on a stand-in ComfyUI", () => {
  const SITE = "http://127.0.0.1:3370";

  it("reads Ready with the nodes and the files, and names the add-on when the nodes are missing", async () => {
    const { parseIndex } = await import("@/lib/gpu/requirements");
    const { gatherInventory } = await import("@/lib/gpu/gather");
    const { fetchTransport } = await import("@/lib/gpu/transport");
    const { workflowReadiness } = await import("@/lib/gpu/readiness");
    const { startLocalComfy } = await import("./helpers/fake-local-comfy");
    const idx = parseIndex(read("requirements.json"));
    const withoutPack = structuredClone(idx);
    for (const id of IDS) withoutPack.workflows[id].packs = {};
    for (const [has, ready] of [[idx, true], [withoutPack, false]] as const) {
      const fake = await startLocalComfy({ cors: SITE, has: has as never });
      try {
        const t = fetchTransport("browser", fake.url, (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), origin: SITE, "sec-fetch-site": "cross-site" } }), { decodes: true });
        const inv = await gatherInventory(t, idx, { where: "computer" });
        for (const id of IDS) {
          const r = workflowReadiness(id, inv, idx, { account: true });
          if (ready) expect(r.state, id).toBe("ready");
          else expect(r.needs.map((n) => n.key), id).toContain(`pack:${PACK}`);
        }
      } finally {
        await fake.close();
      }
    }
  });
});
