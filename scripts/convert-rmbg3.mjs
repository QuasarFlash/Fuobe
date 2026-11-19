#!/usr/bin/env node
/**
 * Makes RMBG-3.0-bf16.safetensors (bg-remove-rmbg3's model file) from Bria's own files: the four diffusers shards of
 * briaai/RMBG-3.0's transformer, joined into one file in ComfyUI's FIBO 2 key layout. CPU only, no Python, no GPU.
 *
 *   node scripts/convert-rmbg3.mjs <folder with the four shards> <ComfyUI models/diffusion_models folder, or a .safetensors path>
 *   node scripts/convert-rmbg3.mjs ... --skip-input-check   # the shards' sizes and SHA-256 are not checked first
 *
 * The layout: attention to_q / to_k / to_v become one qkv, the cross- and Perceiver attentions' to_k / to_v one to_kv, each
 * SwiGLU's w1 / w3 one w13 (w1 first), to_out.0 becomes out (to_out in the cross- and Perceiver attentions), norm_q / norm_k
 * become q_norm / k_norm in the joint attention; everything else keeps its name. Tensors are copied byte for byte (bf16, no
 * cast), sorted by name, with a header as the safetensors library writes one. The result must match the pin of
 * RMBG-3.0-bf16.safetensors in workflows/comfyui/model-pins.json: it is read back from disk and hashed, and a file that
 * doesn't match is left as <name>.part.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OUT_FILE = "RMBG-3.0-bf16.safetensors";
/** The download the converted file must equal (its pin in model-pins.json). */
export const OUT_URL = `https://huggingface.co/1038lab/RMBG-3.0/resolve/f8aa73a836ceeb9c8840e8dc70878b69a7114b78/${OUT_FILE}`;
/** Bria's transformer shards at the revision read (sizes and SHA-256 from the Hugging Face API's LFS oids). */
export const SOURCE = { repo: "briaai/RMBG-3.0", revision: "87330e3f87d9d856a21453e5acd120219984a66b", folder: "transformer" };
export const SHARDS = [
  { file: "diffusion_pytorch_model-00001-of-00004.safetensors", sizeBytes: 4996274842, sha256: "51eb0fdada5641207ac896407b7cbc20aef5dbe20c1e6746fe5baa257e916507" },
  { file: "diffusion_pytorch_model-00002-of-00004.safetensors", sizeBytes: 4999943404, sha256: "c0ce25f35dda1d3ee9c1aca8ac573e29b163aa2837f7398da62118906ba29461" },
  { file: "diffusion_pytorch_model-00003-of-00004.safetensors", sizeBytes: 4999944124, sha256: "e19da4c3d63101c68bbd5b65e225cd26434d9d62a8fd87a541b12b7c08ed0d44" },
  { file: "diffusion_pytorch_model-00004-of-00004.safetensors", sizeBytes: 1258606904, sha256: "4ef85b4d5db2e189ba8d5e3d1e218ee0a4009621a7862590ae63403d9b789c41" },
];

const JOINT = String.raw`((?:layers|noise_refiner)\.\d+\.attention)`;
const OTHER_ATTN = String.raw`((?:layers\.\d+\.cross_attention)|(?:perceiver\.layers\.\d+\.(?:cross|self)_attention))`;
const FFN = String.raw`((?:(?:layers|noise_refiner)\.\d+\.feed_forward)|(?:perceiver\.layers\.\d+\.ffn))`;

/** Tensors joined along their first dimension: the pattern of a part, the joined name, and its parts in order. */
const JOINS = [
  { re: new RegExp(`^${JOINT}\\.to_[qkv]\\.weight$`), to: (p) => `${p}.qkv.weight`, parts: (p) => ["q", "k", "v"].map((x) => `${p}.to_${x}.weight`) },
  { re: new RegExp(`^${OTHER_ATTN}\\.to_[kv]\\.weight$`), to: (p) => `${p}.to_kv.weight`, parts: (p) => ["k", "v"].map((x) => `${p}.to_${x}.weight`) },
  { re: new RegExp(`^${FFN}\\.w[13]\\.weight$`), to: (p) => `${p}.w13.weight`, parts: (p) => ["1", "3"].map((x) => `${p}.w${x}.weight`) },
];
/** Tensors renamed: [pattern, the new name]. */
const RENAMES = [
  [new RegExp(`^${JOINT}\\.to_out\\.0\\.weight$`), "$1.out.weight"],
  [new RegExp(`^${JOINT}\\.norm_q\\.weight$`), "$1.q_norm.weight"],
  [new RegExp(`^${JOINT}\\.norm_k\\.weight$`), "$1.k_norm.weight"],
  [new RegExp(`^${OTHER_ATTN}\\.to_out\\.0\\.weight$`), "$1.to_out.weight"],
];
/** Tensors kept as they are. Any other name stops the conversion: the upstream layout changed. */
const KEEPS = [
  /^x_embedder\.(weight|bias)$/,
  /^t_embedder\.mlp\.[02]\.(weight|bias)$/,
  /^final_layer\.(linear|adaLN_modulation\.1)\.(weight|bias)$/,
  /^(layers|noise_refiner)\.\d+\.adaLN_modulation\.0\.(weight|bias)$/,
  /^(layers|noise_refiner)\.\d+\.(attention_norm1|attention_norm2|ffn_norm1|ffn_norm2)\.weight$/,
  /^layers\.\d+\.(cross_attn_norm1|cross_attn_norm2)\.weight$/,
  /^layers\.\d+\.cross_attn_gate$/,
  new RegExp(`^${FFN}\\.w2\\.weight$`),
  new RegExp(`^${OTHER_ATTN}\\.(to_q|norm_q|norm_k)\\.weight$`),
  /^perceiver\.layers\.\d+\.(cross_attn_norm|self_attn_norm|ffn_norm)\.weight$/,
  /^perceiver\.(latent_queries|norm_out\.weight)$/,
];

const DTYPE_BYTES = { BF16: 2, F16: 2, F32: 4, F64: 8, I64: 8, I32: 4, I16: 2, I8: 1, U8: 1, BOOL: 1 };

/** A safetensors file's header: its tensors (name, dtype, shape, absolute byte range) and where the data starts. */
export function readHeader(file) {
  const fd = fs.openSync(file, "r");
  try {
    const len = Buffer.alloc(8);
    fs.readSync(fd, len, 0, 8, 0);
    const n = Number(len.readBigUInt64LE(0));
    if (n <= 0 || n > 100 * 2 ** 20) throw new Error(`${file}: not a safetensors file (header of ${n} bytes)`);
    const json = Buffer.alloc(n);
    fs.readSync(fd, json, 0, n, 8);
    const header = JSON.parse(json.toString("utf8"));
    const tensors = Object.entries(header)
      .filter(([k]) => k !== "__metadata__")
      .map(([name, t]) => ({ name, dtype: t.dtype, shape: t.shape, start: 8 + n + t.data_offsets[0], end: 8 + n + t.data_offsets[1] }));
    return { tensors, dataStart: 8 + n };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The output's tensors, sorted by name, each with the byte ranges of the source tensors it is made of (in order).
 * `sources`: every input tensor as readHeader gives it, plus its file.
 */
export function planLayout(sources) {
  const byName = new Map();
  for (const s of sources) {
    if (byName.has(s.name)) throw new Error(`${s.name} is in two shards`);
    byName.set(s.name, s);
  }
  const out = new Map();
  const used = new Set();
  const add = (name, parts) => {
    if (out.has(name)) throw new Error(`${name} would be written twice`);
    const [first] = parts;
    for (const p of parts) {
      if (p.dtype !== first.dtype) throw new Error(`${name}: ${p.name} is ${p.dtype}, ${first.name} is ${first.dtype}`);
      if (JSON.stringify(p.shape.slice(1)) !== JSON.stringify(first.shape.slice(1)) || !p.shape.length) throw new Error(`${name}: ${p.name} has shape [${p.shape}], ${first.name} [${first.shape}]`);
      const want = p.shape.reduce((a, b) => a * b, 1) * (DTYPE_BYTES[p.dtype] ?? NaN);
      if (p.end - p.start !== want) throw new Error(`${p.name}: ${p.end - p.start} bytes for [${p.shape}] ${p.dtype}`);
    }
    const shape = parts.length > 1 ? [parts.reduce((a, p) => a + p.shape[0], 0), ...first.shape.slice(1)] : first.shape;
    out.set(name, { name, dtype: first.dtype, shape, parts: parts.map((p) => ({ file: p.file, start: p.start, end: p.end })) });
    for (const p of parts) used.add(p.name);
  };
  for (const s of byName.values()) {
    if (used.has(s.name)) continue;
    const join = JOINS.find((j) => j.re.test(s.name));
    if (join) {
      const prefix = join.re.exec(s.name)[1];
      const names = join.parts(prefix);
      const parts = names.map((n) => byName.get(n));
      const missing = names.filter((_n, i) => !parts[i]);
      if (missing.length) throw new Error(`${join.to(prefix)}: ${missing.join(", ")} missing`);
      add(join.to(prefix), parts);
      continue;
    }
    const rename = RENAMES.find(([re]) => re.test(s.name));
    if (rename) add(s.name.replace(rename[0], rename[1]), [s]);
    else if (KEEPS.some((re) => re.test(s.name))) add(s.name, [s]);
    else throw new Error(`${s.name}: a tensor this conversion doesn't know (has the upstream layout changed?)`);
  }
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The header the safetensors library writes: names sorted, offsets in that order, no metadata, padded with spaces to 8 bytes. */
export function headerBytes(plan) {
  let offset = 0;
  const header = {};
  for (const t of plan) {
    const size = t.parts.reduce((a, p) => a + (p.end - p.start), 0);
    header[t.name] = { dtype: t.dtype, shape: t.shape, data_offsets: [offset, offset + size] };
    offset += size;
  }
  let json = Buffer.from(JSON.stringify(header), "utf8");
  const pad = (8 - (json.length % 8)) % 8;
  if (pad) json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  return { bytes: Buffer.concat([len, json]), dataBytes: offset };
}

const CHUNK = 64 * 2 ** 20;

/** SHA-256 and size of a file as it is on disk. */
export function hashFile(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(CHUNK);
  let size = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
      size += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sizeBytes: size, sha256: h.digest("hex") };
}

/** The pin the output must match: model-pins.json's entry for OUT_URL. */
export function outputPin(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const pins = JSON.parse(fs.readFileSync(path.join(root, "workflows/comfyui/model-pins.json"), "utf8"));
  const pin = pins[OUT_URL];
  if (!pin?.sha256) throw new Error(`model-pins.json has no pin for ${OUT_URL}`);
  return pin;
}

/**
 * Converts the shards in `dir` into `out`. Checks each shard's size and SHA-256 first (unless checkInputs is false), writes
 * `out`.part, reads it back, and renames it to `out` only when its size and SHA-256 are `expect`'s.
 */
export function convert({ dir, out, shards = SHARDS, expect = outputPin(), checkInputs = true, log = console.log }) {
  for (const s of shards) {
    const file = path.join(dir, s.file);
    if (!fs.existsSync(file)) throw new Error(`${file} is missing`);
    const size = fs.statSync(file).size;
    if (size !== s.sizeBytes) throw new Error(`${s.file}: ${size} bytes, the pin says ${s.sizeBytes}`);
    if (checkInputs) {
      log(`checking ${s.file}`);
      const { sha256 } = hashFile(file);
      if (sha256 !== s.sha256) throw new Error(`${s.file}: SHA-256 ${sha256}, the pin says ${s.sha256}`);
    }
  }
  const sources = shards.flatMap((s) => readHeader(path.join(dir, s.file)).tensors.map((t) => ({ ...t, file: path.join(dir, s.file) })));
  const plan = planLayout(sources);
  const { bytes, dataBytes } = headerBytes(plan);
  const total = bytes.length + dataBytes;
  if (expect.sizeBytes !== undefined && total !== expect.sizeBytes) throw new Error(`the result would be ${total} bytes, the pin says ${expect.sizeBytes}`);
  log(`${sources.length} tensors in, ${plan.length} out, ${total} bytes`);
  const part = `${out}.part`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fdOut = fs.openSync(part, "w");
  const buf = Buffer.alloc(CHUNK);
  const fds = new Map();
  try {
    fs.writeSync(fdOut, bytes);
    for (const t of plan) {
      for (const p of t.parts) {
        if (!fds.has(p.file)) fds.set(p.file, fs.openSync(p.file, "r"));
        const fd = fds.get(p.file);
        for (let at = p.start; at < p.end; ) {
          const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, p.end - at), at);
          if (!n) throw new Error(`${p.file}: ended at byte ${at}`);
          fs.writeSync(fdOut, buf, 0, n);
          at += n;
        }
      }
    }
    fs.fsyncSync(fdOut);
  } finally {
    fs.closeSync(fdOut);
    for (const fd of fds.values()) fs.closeSync(fd);
  }
  log(`reading ${part} back`);
  const got = hashFile(part);
  if (got.sizeBytes !== total || got.sha256 !== expect.sha256) {
    throw new Error(`${part}: ${got.sizeBytes} bytes, SHA-256 ${got.sha256}; the pin says ${expect.sizeBytes} bytes, ${expect.sha256}. Left as ${path.basename(part)}.`);
  }
  fs.renameSync(part, out);
  log(`${out}: ${got.sizeBytes} bytes, SHA-256 ${got.sha256} (matches its pin)`);
  return got;
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  if (args.length !== 2) {
    console.error("usage: node scripts/convert-rmbg3.mjs <folder with the four shards> <models/diffusion_models folder or .safetensors path> [--skip-input-check]");
    return 2;
  }
  const [dir, dest] = args;
  const out = dest.endsWith(".safetensors") ? dest : path.join(dest, OUT_FILE);
  try {
    convert({ dir, out, checkInputs: !argv.includes("--skip-input-check") });
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
