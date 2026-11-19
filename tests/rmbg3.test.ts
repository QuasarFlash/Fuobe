import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getModel, getPreset, modelsFor } from "@/lib/catalog";
import { planGeneration, routesFor } from "@/lib/catalog/plan";
import type { GenInput } from "@/lib/catalog/types";
import type { ComfyWorkflow, Manifest } from "@/lib/comfy";
import { TOOL_MODELS } from "@/lib/layers";
import { licenceInfo, licenceTerms } from "@/lib/licences";
import { modelHref } from "@/lib/palette-index";
import { graphCheck } from "../bin/lib/worker/checks.mjs";
import { loaderInput } from "../bin/lib/worker/rules.mjs";
import { convert, hashFile, headerBytes, OUT_FILE, OUT_URL, outputPin, planLayout, readHeader, SHARDS, SOURCE } from "../scripts/convert-rmbg3.mjs";
import { allowedNodeList, inputRules, readCatalog } from "../scripts/lib/worker-catalog.mjs";
import { tempDir } from "./helpers/temp-dir";

// Bria's RMBG-3.0 on your GPU (bg-remove-rmbg3): the FIBO 2 Edit Turbo graph with RMBG-3.0's transformer and the card's fixed
// instruction, its matte joined to the picture as alpha with core nodes; the file pinned; the CPU conversion that makes that
// file from Bria's own shards, on a small made-up set of tensors.
process.env.FUOBE_DATA_DIR = tempDir("fuobe-rmbg3-");
process.env.COMFYUI_URL = "http://comfy.test:8188";
const { prepareWorkflow } = await import("@/server/providers/comfyui");
const { STUDIO_ROWS, studioTool } = await import("@/server/gpu/tools");

const root = path.resolve(__dirname, "..");
const dir = path.join(root, "workflows/comfyui");
const read = <T>(f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T;
const manifest = read<Manifest>("manifest.json");
const pins = read<Record<string, { revision: string; sizeBytes: number; sha256?: string }>>("model-pins.json");
const requirements = read<{ files: Record<string, { url: string; sizeBytes: number }>; workflows: Record<string, { core: string[]; packs: Record<string, string[]>; files: string[]; optional: string[]; vramGb: number; firstRun: string[] }> }>("requirements.json");
const subset = read<Record<string, unknown>>("object_info.subset.json");

const ID = "bg-remove-rmbg3";
const MODEL = "oss-rmbg3";
const entry = manifest.workflows.find((w) => w.id === ID)!;
const graph = read<ComfyWorkflow>(`${ID}.json`);
/** The model card's instruction, as its code sends it: json.dumps({"edit_instruction": INSTRUCTION}). */
const INSTRUCTION =
  "Generate a detailed grayscale alpha matte. Map the opaque foreground to white and the background to black. Produce soft, anti-aliased grayscale gradients at the edges of the subject to represent fine details and transparency.";

describe("bg-remove-rmbg3 in the library", () => {
  it("is the FIBO 2 Edit Turbo graph on RMBG-3.0's transformer with the card's instruction, word for word", () => {
    expect(graph).toEqual(JSON.parse(fs.readFileSync(path.join(root, "scripts/comfy/hand-built", `${ID}.json`), "utf8")));
    for (const n of Object.values(graph)) expect(subset[n.class_type], n.class_type).toBeTruthy();
    expect(graph["2"]).toMatchObject({ class_type: "UNETLoader", inputs: { unet_name: OUT_FILE, weight_dtype: "default" } });
    // FIBO 2 Edit Turbo's encoder and VAE, as fibo2-edit-turbo-edit loads them.
    const turbo = read<ComfyWorkflow>("fibo2-edit-turbo-edit.json");
    expect(graph["3"].inputs).toEqual(turbo["38"].inputs);
    expect(graph["4"].inputs).toEqual(turbo["39"].inputs);
    expect(graph["5"].class_type).toBe("TextEncodeFibo2");
    expect(graph["5"].inputs).toEqual({ clip: ["3", 0], prompt: `{"edit_instruction": ${JSON.stringify(INSTRUCTION)}}`, negative_prompt: "", vae: ["4", 0], "images.image_1": ["1", 0], width: 0, height: 0, batch_size: 1 });
    expect(JSON.parse(String(graph["5"].inputs.prompt))).toEqual({ edit_instruction: INSTRUCTION });
    expect(graph["6"]).toMatchObject({ class_type: "KSampler", inputs: { model: ["2", 0], positive: ["5", 0], negative: ["5", 1], latent_image: ["5", 2], seed: 0, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } });
  });

  it("scales the matte to the picture, reads it as a mask and joins it as alpha: a transparent PNG at full size", () => {
    expect(graph["7"]).toMatchObject({ class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["4", 0] } });
    expect(graph["8"]).toMatchObject({ class_type: "GetImageSize", inputs: { image: ["1", 0] } });
    expect(graph["9"]).toMatchObject({ class_type: "ImageScale", inputs: { image: ["7", 0], upscale_method: "lanczos", width: ["8", 0], height: ["8", 1], crop: "disabled" } });
    expect(graph["10"]).toMatchObject({ class_type: "ImageToMask", inputs: { image: ["9", 0], channel: "red" } });
    // JoinImageWithAlpha keeps 1 - mask: the matte (white = the subject) is inverted first, as bg-remove-birefnet does.
    expect(graph["11"]).toMatchObject({ class_type: "InvertMask", inputs: { mask: ["10", 0] } });
    expect(graph["12"]).toMatchObject({ class_type: "JoinImageWithAlpha", inputs: { image: ["1", 0], alpha: ["11", 0] } });
    expect(graph["13"]).toMatchObject({ class_type: "SaveImage", inputs: { images: ["12", 0] } });
    const birefnet = read<ComfyWorkflow>("bg-remove-birefnet.json");
    expect(Object.values(birefnet).map((n) => n.class_type)).toEqual(expect.arrayContaining(["InvertMask", "JoinImageWithAlpha"]));
  });

  it("is a bg-remove entry of core nodes, 32 GB, with its licence as information", () => {
    expect(entry).toMatchObject({ capability: "bg-remove", customNodes: [], vramGb: 32, validated: false, outputs: [{ node: "13", kind: "image" }], source: `hand-built (scripts/comfy/hand-built/${ID}.json)` });
    expect(Object.keys(entry.bindings).sort()).toEqual(["filenamePrefix", "image"]);
    expect(entry.bindings.image).toEqual([{ node: "1", input: "image" }]);
    expect(entry.limits).toEqual({ maxWidth: 4096, maxHeight: 4096 });
    expect(entry.license).toMatch(/^CC-BY-NC-4\.0 \(Bria RMBG-3\.0 weights, non-commercial/);
    expect(entry.license).not.toMatch(/permission|agreement|needs/i);
    expect(licenceTerms(entry.license!).flags).toEqual(["non-commercial"]);
    expect(licenceInfo(entry.license!).class).not.toBe("unknown");
    expect(entry.notes).toMatch(/28\.5 GiB/);
  });

  it("pins every file by size and SHA-256: RMBG-3.0's single file, and FIBO 2's encoder and VAE", () => {
    const r = requirements.workflows[ID];
    expect([...r.files].sort()).toEqual([`diffusion_models/${OUT_FILE}`, "text_encoders/qwen3vl_4b_int8_convrot.safetensors", "vae/flux2-vae.safetensors"]);
    expect(r).toMatchObject({ packs: {}, optional: [], vramGb: 32, firstRun: [] });
    expect(r.core).toEqual(expect.arrayContaining(["TextEncodeFibo2", "ImageScale", "ImageToMask", "InvertMask", "JoinImageWithAlpha", "GetImageSize"]));
    for (const f of r.files) expect(pins[requirements.files[f].url]?.sha256, f).toMatch(/^[0-9a-f]{64}$/);
    expect(pins[OUT_URL]).toEqual({ revision: "f8aa73a836ceeb9c8840e8dc70878b69a7114b78", sizeBytes: 16254753314, sha256: "a864baf0379d355982142a5577e96d82486fc6ee1628aa3ce363ae93f7f8296a" });
    expect(entry.models.find((m) => m.file === OUT_FILE)).toMatchObject({ folder: "diffusion_models", url: OUT_URL });
    expect(outputPin(root)).toEqual(pins[OUT_URL]);
  });
});

describe("RMBG-3.0 in the catalog", () => {
  const model = getModel(MODEL)!;

  it("is an open cut-out model on its graph, its card's 32 GB in the tagline, no price", () => {
    expect(model).toMatchObject({ engine: "open", kind: "image", vendor: "Bria", family: "bria", name: "Bria RMBG-3.0" });
    expect(model.routes.map((r) => [r.op, r.provider, r.endpoint])).toEqual([["bg-remove", "comfyui", ID]]);
    expect(model.tagline).toMatch(/32 GB GPU$/);
    expect(JSON.stringify(model)).not.toMatch(/\$|price|credit/i);
    expect(model.hidden).toBeFalsy();
  });

  it("is offered in Layers → Remove background after the default, and opens there", () => {
    expect(TOOL_MODELS["bg-remove"].open).toEqual(["oss-rmbg", "oss-matte-feynobg", MODEL]);
    expect(modelsFor({ kind: "image", ops: ["bg-remove"] }).map((m) => m.id)).toContain(MODEL);
    expect(modelHref(model)).toBe("/layers");
    const p = planGeneration({ feature: "image", modelId: MODEL, inputs: { images: ["/api/files/p.png"] } } as never, getModel, getPreset);
    expect([p.op, routesFor(p.model, p.op).map((r) => r.endpoint)]).toEqual(["bg-remove", [ID]]);
  });

  it("has a row on the GPU board that names its graph", () => {
    const row = STUDIO_ROWS.find((r) => r.steps?.some((s) => s.modelId === MODEL))!;
    expect(row).toMatchObject({ href: "/layers", label: "Remove background · RMBG-3.0", group: "Images", steps: [{ modelId: MODEL, op: "bg-remove" }] });
    expect(studioTool(row)?.workflows).toEqual([ID]);
  });
});

describe("bg-remove-rmbg3 as the provider fills it, and as a worker takes it", () => {
  type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  const prepare = async (input: GenInput) => (await prepareWorkflow(ID, input, { generationId: "g-rmbg3", op: "bg-remove", upload: async (_d, _t, name) => name })).workflow as unknown as Graph;
  const catalog = readCatalog(root) as unknown as { requirements: { files: Record<string, { folder: string; file: string }> } };
  const rules = inputRules(catalog as never);
  const allowed = new Set(allowedNodeList(root, catalog as never));
  const verified = Object.values(catalog.requirements.files).map((f) => ({ folder: f.folder, name: f.file }));
  const sent = (g: Graph) => Object.values(g).flatMap((n) => Object.entries(n.inputs).filter(([k, v]) => loaderInput(n.class_type, k) && typeof v === "string").map(([, v]) => v as string));

  it("binds the picture and the save name, and keeps the instruction whatever words come with the run", async () => {
    const g = await prepare({ images: ["fuobe_abcdefgh01.png"], prompt: "keep the dog" } as GenInput);
    expect(g["1"].inputs.image).toBe("fuobe_abcdefgh01.png");
    expect(String(g["13"].inputs.filename_prefix)).toMatch(/^fuobe\//);
    expect(g["5"].inputs.prompt).toBe(graph["5"].inputs.prompt);
    expect(g["5"].inputs["images.image_1"]).toEqual(["1", 0]);
  });

  it("passes the worker's checks, and is refused while RMBG-3.0's file isn't verified there", async () => {
    const g = await prepare({ images: ["fuobe_abcdefgh01.png"] } as GenInput);
    expect(graphCheck(g, allowed, verified, { rules, staged: sent(g) })).toBeNull();
    expect(graphCheck(g, allowed, verified.filter((v) => v.name !== OUT_FILE), { rules, staged: sent(g) })?.reason).toBe("model-unverified");
  });
});

// ---- the conversion, on a made-up model of a few tiny tensors ------------------------------------------------------------------

type T = { dtype: string; shape: number[]; data: Buffer };
let fill = 1;
const tensor = (...shape: number[]): T => {
  const data = Buffer.alloc(shape.reduce((a, b) => a * b, 1) * 2);
  for (let i = 0; i < data.length; i++) data[i] = fill++ % 251;
  return { dtype: "BF16", shape, data };
};
/** Writes a safetensors file with its tensors in the order given (and, like Bria's shards, a __metadata__ entry). */
function writeSafetensors(file: string, tensors: Record<string, T>) {
  let offset = 0;
  const header: Record<string, unknown> = { __metadata__: { format: "pt" } };
  for (const [name, t] of Object.entries(tensors)) {
    header[name] = { dtype: t.dtype, shape: t.shape, data_offsets: [offset, offset + t.data.length] };
    offset += t.data.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  fs.writeFileSync(file, Buffer.concat([len, json, ...Object.values(tensors).map((t) => t.data)]));
}
/** A FIBO 2 transformer in Bria's diffusers names: two joint blocks (one with cross-attention), a refiner block, the Perceiver. */
function diffusersModel(): Record<string, T> {
  const m: Record<string, T> = {
    "x_embedder.weight": tensor(4, 8),
    "x_embedder.bias": tensor(4),
    "t_embedder.mlp.0.weight": tensor(4, 2),
    "t_embedder.mlp.0.bias": tensor(4),
    "t_embedder.mlp.2.weight": tensor(2, 4),
    "t_embedder.mlp.2.bias": tensor(2),
    "final_layer.linear.weight": tensor(8, 4),
    "final_layer.linear.bias": tensor(8),
    "final_layer.adaLN_modulation.1.weight": tensor(4, 2),
    "final_layer.adaLN_modulation.1.bias": tensor(4),
    "perceiver.latent_queries": tensor(3, 4),
    "perceiver.norm_out.weight": tensor(4),
  };
  for (const b of ["layers.0", "layers.1", "noise_refiner.0"]) {
    for (const x of ["q", "k", "v"]) m[`${b}.attention.to_${x}.weight`] = tensor(4, 4);
    m[`${b}.attention.to_out.0.weight`] = tensor(4, 4);
    m[`${b}.attention.norm_q.weight`] = tensor(2);
    m[`${b}.attention.norm_k.weight`] = tensor(2);
    for (const w of ["w1", "w3"]) m[`${b}.feed_forward.${w}.weight`] = tensor(6, 4);
    m[`${b}.feed_forward.w2.weight`] = tensor(4, 6);
    for (const n of ["attention_norm1", "attention_norm2", "ffn_norm1", "ffn_norm2"]) m[`${b}.${n}.weight`] = tensor(4);
    m[`${b}.adaLN_modulation.0.weight`] = tensor(16, 2);
    m[`${b}.adaLN_modulation.0.bias`] = tensor(16);
  }
  const attention = (p: string, kv: number) => {
    m[`${p}.to_q.weight`] = tensor(4, 4);
    m[`${p}.to_k.weight`] = tensor(4, kv);
    m[`${p}.to_v.weight`] = tensor(4, kv);
    m[`${p}.to_out.0.weight`] = tensor(4, 4);
    m[`${p}.norm_q.weight`] = tensor(2);
    m[`${p}.norm_k.weight`] = tensor(2);
  };
  m["layers.1.cross_attn_gate"] = tensor(1);
  m["layers.1.cross_attn_norm1.weight"] = tensor(4);
  m["layers.1.cross_attn_norm2.weight"] = tensor(4);
  attention("layers.1.cross_attention", 5);
  attention("perceiver.layers.0.cross_attention", 5);
  attention("perceiver.layers.0.self_attention", 4);
  for (const n of ["cross_attn_norm", "self_attn_norm", "ffn_norm"]) m[`perceiver.layers.0.${n}.weight`] = tensor(4);
  for (const w of ["w1", "w3"]) m[`perceiver.layers.0.ffn.${w}.weight`] = tensor(6, 4);
  m["perceiver.layers.0.ffn.w2.weight"] = tensor(4, 6);
  return m;
}
/** The names ComfyUI's FIBO 2 loader reads for that model (the layout of Comfy-Org's own FIBO 2 files). */
const COMFY_NAMES = [
  "final_layer.adaLN_modulation.1.bias",
  "final_layer.adaLN_modulation.1.weight",
  "final_layer.linear.bias",
  "final_layer.linear.weight",
  ...["layers.0", "layers.1", "noise_refiner.0"].flatMap((b) => [
    `${b}.adaLN_modulation.0.bias`,
    `${b}.adaLN_modulation.0.weight`,
    `${b}.attention.k_norm.weight`,
    `${b}.attention.out.weight`,
    `${b}.attention.q_norm.weight`,
    `${b}.attention.qkv.weight`,
    `${b}.attention_norm1.weight`,
    `${b}.attention_norm2.weight`,
    `${b}.feed_forward.w13.weight`,
    `${b}.feed_forward.w2.weight`,
    `${b}.ffn_norm1.weight`,
    `${b}.ffn_norm2.weight`,
  ]),
  ...["layers.1.cross_attention", "perceiver.layers.0.cross_attention", "perceiver.layers.0.self_attention"].flatMap((p) => [`${p}.norm_k.weight`, `${p}.norm_q.weight`, `${p}.to_kv.weight`, `${p}.to_out.weight`, `${p}.to_q.weight`]),
  "layers.1.cross_attn_gate",
  "layers.1.cross_attn_norm1.weight",
  "layers.1.cross_attn_norm2.weight",
  "perceiver.latent_queries",
  "perceiver.layers.0.cross_attn_norm.weight",
  "perceiver.layers.0.ffn.w13.weight",
  "perceiver.layers.0.ffn.w2.weight",
  "perceiver.layers.0.ffn_norm.weight",
  "perceiver.layers.0.self_attn_norm.weight",
  "perceiver.norm_out.weight",
  "t_embedder.mlp.0.bias",
  "t_embedder.mlp.0.weight",
  "t_embedder.mlp.2.bias",
  "t_embedder.mlp.2.weight",
  "x_embedder.bias",
  "x_embedder.weight",
].sort();

/** The made-up model in two shards (names shuffled across them), with their pins. */
function shardsOf(model: Record<string, T>, at: string) {
  const names = Object.keys(model).reverse();
  const half = Math.ceil(names.length / 2);
  return [names.slice(0, half), names.slice(half)].map((list, i) => {
    const file = `diffusion_pytorch_model-0000${i + 1}-of-00002.safetensors`;
    writeSafetensors(path.join(at, file), Object.fromEntries(list.map((n) => [n, model[n]])));
    return { file, ...hashFile(path.join(at, file)) };
  });
}
function tensorBytes(file: string) {
  const buf = fs.readFileSync(file);
  return Object.fromEntries(readHeader(file).tensors.map((t) => [t.name, { ...t, data: buf.subarray(t.start, t.end) }]));
}

describe("scripts/convert-rmbg3.mjs", () => {
  it("names Bria's four shards with their sizes and SHA-256, and the pin the result must match", () => {
    expect(SOURCE).toEqual({ repo: "briaai/RMBG-3.0", revision: "87330e3f87d9d856a21453e5acd120219984a66b", folder: "transformer" });
    expect(SHARDS.map((s) => s.file)).toEqual([1, 2, 3, 4].map((i) => `diffusion_pytorch_model-0000${i}-of-00004.safetensors`));
    for (const s of SHARDS) expect(s.sha256, s.file).toMatch(/^[0-9a-f]{64}$/);
    // The shards hold 16,254,684,426 bytes of tensors; the single file adds its own header.
    expect(SHARDS.reduce((a, s) => a + s.sizeBytes, 0)).toBe(16254769274);
    expect(OUT_URL).toBe(requirements.files[`diffusion_models/${OUT_FILE}`].url);
  });

  it("joins q/k/v, k/v and w1/w3 in order, renames the rest as ComfyUI's FIBO 2 layout reads it, and copies every byte", () => {
    const at = tempDir("fuobe-rmbg3-convert-");
    const model = diffusersModel();
    const shards = shardsOf(model, at);
    const out = path.join(at, "out", OUT_FILE);
    const quiet = () => {};
    // A pin the result doesn't match: the file stays as .part, and nothing is at the final name.
    expect(() => convert({ dir: at, out, shards, expect: { sha256: "0".repeat(64) }, log: quiet })).toThrow(/the pin says .*Left as RMBG-3\.0-bf16\.safetensors\.part/);
    expect(fs.existsSync(out)).toBe(false);
    const part = `${out}.part`;
    const got = tensorBytes(part);
    expect(Object.keys(got)).toEqual(COMFY_NAMES);
    const cat = (...names: string[]) => Buffer.concat(names.map((n) => model[n].data));
    for (const b of ["layers.0", "layers.1", "noise_refiner.0"]) {
      expect(got[`${b}.attention.qkv.weight`]).toMatchObject({ dtype: "BF16", shape: [12, 4] });
      expect(got[`${b}.attention.qkv.weight`].data.equals(cat(...["q", "k", "v"].map((x) => `${b}.attention.to_${x}.weight`)))).toBe(true);
      expect(got[`${b}.feed_forward.w13.weight`].shape).toEqual([12, 4]);
      expect(got[`${b}.feed_forward.w13.weight`].data.equals(cat(`${b}.feed_forward.w1.weight`, `${b}.feed_forward.w3.weight`))).toBe(true);
      expect(got[`${b}.attention.out.weight`].data.equals(model[`${b}.attention.to_out.0.weight`].data)).toBe(true);
      expect(got[`${b}.attention.q_norm.weight`].data.equals(model[`${b}.attention.norm_q.weight`].data)).toBe(true);
      expect(got[`${b}.attention.k_norm.weight`].data.equals(model[`${b}.attention.norm_k.weight`].data)).toBe(true);
    }
    for (const [p, kv] of [["layers.1.cross_attention", 5], ["perceiver.layers.0.cross_attention", 5], ["perceiver.layers.0.self_attention", 4]] as const) {
      expect(got[`${p}.to_kv.weight`].shape).toEqual([8, kv]);
      expect(got[`${p}.to_kv.weight`].data.equals(cat(`${p}.to_k.weight`, `${p}.to_v.weight`))).toBe(true);
      expect(got[`${p}.to_out.weight`].data.equals(model[`${p}.to_out.0.weight`].data)).toBe(true);
      for (const k of ["to_q", "norm_q", "norm_k"]) expect(got[`${p}.${k}.weight`].data.equals(model[`${p}.${k}.weight`].data), `${p}.${k}`).toBe(true);
    }
    expect(got["perceiver.layers.0.ffn.w13.weight"].data.equals(cat("perceiver.layers.0.ffn.w1.weight", "perceiver.layers.0.ffn.w3.weight"))).toBe(true);
    for (const k of ["x_embedder.weight", "t_embedder.mlp.2.bias", "final_layer.adaLN_modulation.1.weight", "perceiver.latent_queries", "layers.1.cross_attn_gate", "layers.0.feed_forward.w2.weight"]) {
      expect(got[k].data.equals(model[k].data), k).toBe(true);
      expect(got[k].shape, k).toEqual(model[k].shape);
    }
    // The header as the safetensors library writes it: names sorted, offsets one after another, no metadata, spaces to 8 bytes.
    const buf = fs.readFileSync(part);
    const n = Number(buf.readBigUInt64LE(0));
    expect(n % 8).toBe(0);
    const text = buf.subarray(8, 8 + n).toString("utf8");
    expect(text).toMatch(/^\{"final_layer\.adaLN_modulation\.1\.bias":\{"dtype":"BF16","shape":\[4\],"data_offsets":\[0,8\]\},/);
    expect(text).toMatch(/\} *$/);
    expect(JSON.parse(text).__metadata__).toBeUndefined();
    const all = Object.values(JSON.parse(text) as Record<string, { data_offsets: [number, number] }>);
    all.forEach((t, i) => expect(t.data_offsets[0]).toBe(i ? all[i - 1].data_offsets[1] : 0));
    expect(buf.length).toBe(8 + n + all[all.length - 1].data_offsets[1]);
    // With the right pin it is read back, checked and put in place; the same shards make the same bytes.
    const pin = hashFile(part);
    expect(pin.sha256).toBe(crypto.createHash("sha256").update(buf).digest("hex"));
    expect(convert({ dir: at, out, shards, expect: pin, log: quiet })).toEqual(pin);
    expect([fs.existsSync(out), fs.existsSync(part)]).toEqual([true, false]);
  });

  it("checks the shards first: a missing one, another size or another SHA-256 stops it before anything is written", () => {
    const at = tempDir("fuobe-rmbg3-inputs-");
    const shards = shardsOf(diffusersModel(), at);
    const out = path.join(at, OUT_FILE);
    const run = (s: typeof shards, checkInputs = true) => () => convert({ dir: at, out, shards: s, expect: { sha256: "0".repeat(64) }, checkInputs, log: () => {} });
    expect(run([shards[0], { ...shards[1], sha256: "f".repeat(64) }])).toThrow(/00002-of-00002\.safetensors: SHA-256 [0-9a-f]{64}, the pin says f{64}/);
    expect(run([shards[0], { ...shards[1], sizeBytes: shards[1].sizeBytes + 1 }], false)).toThrow(/bytes, the pin says/);
    expect(run([...shards, { file: "gone.safetensors", sizeBytes: 1, sha256: "0".repeat(64) }])).toThrow(/gone\.safetensors is missing/);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
    // A size the pin says the result can't have stops it before writing too.
    expect(() => convert({ dir: at, out, shards, expect: { sizeBytes: 1, sha256: "0".repeat(64) }, log: () => {} })).toThrow(/the result would be \d+ bytes, the pin says 1/);
    expect(fs.existsSync(`${out}.part`)).toBe(false);
  });

  it("refuses a layout it doesn't know: an unknown tensor, a missing part, another dtype or a tensor in two shards", () => {
    const sources = (m: Record<string, T>) => {
      let at = 0;
      return Object.entries(m).map(([name, t]) => ({ name, dtype: t.dtype, shape: t.shape, start: at, end: (at += t.data.length), file: "x" }));
    };
    expect(planLayout(sources(diffusersModel())).map((t: { name: string }) => t.name)).toEqual(COMFY_NAMES);
    const extra = { ...diffusersModel(), "layers.0.attention.to_gate.weight": tensor(4, 4) };
    expect(() => planLayout(sources(extra))).toThrow(/layers\.0\.attention\.to_gate\.weight: a tensor this conversion doesn't know/);
    const noV = diffusersModel();
    delete noV["layers.1.cross_attention.to_v.weight"];
    expect(() => planLayout(sources(noV))).toThrow(/layers\.1\.cross_attention\.to_kv\.weight: layers\.1\.cross_attention\.to_v\.weight missing/);
    const f32 = diffusersModel();
    f32["noise_refiner.0.feed_forward.w3.weight"] = { dtype: "F32", shape: [6, 2], data: Buffer.alloc(48) };
    expect(() => planLayout(sources(f32))).toThrow(/noise_refiner\.0\.feed_forward\.w13\.weight: .* is F32/);
    const twice = sources(diffusersModel());
    expect(() => planLayout([...twice, twice[0]])).toThrow(/is in two shards/);
    // The header alone, for a plan: sorted names, the data size it describes.
    const { bytes, dataBytes } = headerBytes(planLayout(sources(diffusersModel())));
    expect(bytes.length % 8).toBe(0);
    expect(dataBytes).toBe(Object.values(diffusersModel()).reduce((a, t) => a + t.data.length, 0));
  });

  it("says how to run it when called without its two folders", () => {
    const r = spawnSync(process.execPath, [path.join(root, "scripts/convert-rmbg3.mjs")], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^usage: node scripts\/convert-rmbg3\.mjs <folder with the four shards>/);
  });
});
