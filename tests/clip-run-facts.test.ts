import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GenerationRequest } from "@/lib/catalog/types";
import { listenOnFreePort, startFakeBilling, type FakeBilling } from "./helpers/fake-billing";
import { startFakeComfy, TINY_PNG, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

// A run whose result follows its input clip (motion transfer, a clip edit, a swap) is as long as that clip: the facts a
// run's price check and its hold send say the clip's seconds, read from the uploaded file's header, not a model's
// default or nothing.
const dir = tempDir("fuobe-clip-facts-");
process.env.FUOBE_DATA_DIR = dir;
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_MODERATION_URL;
globalThis.__fuobeTestDiskFree = 1e13;

const probe = http.createServer();
const comfyPort = await listenOnFreePort(probe);
await new Promise<void>((r) => probe.close(() => r()));
const comfy: FakeComfy = await startFakeComfy({ output: "video", delayMs: 0 }, comfyPort);
process.env.COMFYUI_URL = comfy.url;

const auth = await import("@/server/auth");
const uploadsRoute = await import("@/app/api/uploads/route");
const { resetRates } = await import("@/server/rate");
const billing = await import("@/server/billing");
const { clipRunSeconds, runFacts, runOnPool } = await import("@/server/hosted");
const { poolQuote, reservePool } = await import("@/server/hosted-run");
const { previewGeneration } = await import("@/server/generations");

/** A tiny MP4 header `seconds` long (ftyp + moov with one 1280×720 video trak), enough for the server's header read. */
function mp4(seconds: number): Buffer {
  const box = (type: string, ...body: Buffer[]) => {
    const data = Buffer.concat(body);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + data.length);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, data]);
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(seconds * 1000, 16);
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(0x10000, 40);
  tkhd.writeUInt32BE(0x10000, 56);
  tkhd.writeUInt32BE(1280 << 16, 76);
  tkhd.writeUInt32BE(720 << 16, 80);
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(1000, 12);
  mdhd.writeUInt32BE(seconds * 1000, 16);
  const hdlr = Buffer.alloc(24);
  hdlr.write("vide", 8, "latin1");
  const trak = box("trak", box("tkhd", tkhd), box("mdia", box("mdhd", mdhd), box("hdlr", hdlr)));
  return Buffer.concat([box("ftyp", Buffer.from("isom\0\0\0\0isomiso2mp41", "latin1")), box("moov", box("mvhd", mvhd), trak)]);
}

let fake: FakeBilling;
let a = "";
let cookie = "";
let clip30 = "";
let picture = "";

const headers = (extra: Record<string, string> = {}) => ({ cookie, host: "localhost:3000", ...extra });
const upload = async (bytes: Buffer, type: string, name: string) => {
  const r = await uploadsRoute.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: headers({ "content-type": type, "x-file-name": name, "content-length": String(bytes.length) }), body: new Uint8Array(bytes) }));
  expect(r.status).toBe(201);
  return ((await r.json()) as { url: string }).url;
};

const POLICY = { hosted: true, pool: {}, uploads: { image: true, video: true, audio: true }, limits: { activeRuns: 7, waiting: 7, runsPerHour: 70, outputsPerRun: 2, maxMegapixels: 70, maxSeconds: 700, keepDays: 7, spaceBytes: 7_000_000_000 }, ttlS: 0 };

beforeAll(async () => {
  fake = await startFakeBilling();
  fake.policy = POLICY;
  process.env.FUOBE_HOSTED_RUNS = "1";
  process.env.FUOBE_BILLING_URL = fake.url;
  process.env.FUOBE_BILLING_TOKEN = "test-billing-token";
  auth.setPassword("install password");
  a = auth.createAccount("clips@example.com", "long enough").id;
  cookie = `${auth.SESSION_COOKIE}=${auth.createSession(a).value}`;
  clip30 = await upload(mp4(30), "video/mp4", "dance.mp4");
  picture = await upload(TINY_PNG, "image/png", "me.png");
});
afterAll(async () => {
  globalThis.__fuobeTestDiskFree = undefined;
  for (const k of ["FUOBE_HOSTED_RUNS", "FUOBE_BILLING_URL", "FUOBE_BILLING_TOKEN"]) delete process.env[k];
  await fake.close();
  await comfy.close();
});
beforeEach(() => {
  resetRates();
  billing.resetBillingCache();
  fake.policy = POLICY;
});

/** The facts of a request as the price check plans it, read as the account. */
function factsOf(req: GenerationRequest) {
  const planned = runOnPool(a, () => previewGeneration(req));
  return runOnPool(a, () => runFacts(req, planned, "video"));
}

const motionLite = (): GenerationRequest => ({
  feature: "video",
  modelId: "fuobe-genjutsu-motion-lite",
  op: "motion-transfer",
  prompt: "",
  inputs: { images: [picture], video: clip30 },
  params: { resolution: "480p", extra: { steps: 4 } },
});

describe("a run that follows a clip carries the clip's length", () => {
  it("motion transfer Lite with a 30 s clip: 30 s, at the price check and at the hold", async () => {
    const account = auth.accountById(a)!;
    const req = motionLite();
    const before = fake.calls.length;
    const quoted = await poolQuote(account, req, undefined);
    expect(quoted?.planned?.model.id).toBe("fuobe-genjutsu-motion-lite");
    const quoteCall = fake.calls.slice(before).find((c) => c.path.split("?")[0] === "/v1/quote");
    expect(quoteCall, "the price check asked the service").toBeTruthy();
    expect((quoteCall!.body as { run: { seconds: number | null; op: string } }).run).toMatchObject({ seconds: 30, op: "motion-transfer" });

    const at = fake.calls.length;
    const held = await reservePool(account, req, quoted!.planned!, { amount: 7, priceVersion: "v7" }, false);
    expect(held.ok).toBe(true);
    const reserveCall = fake.calls.slice(at).find((c) => c.path.split("?")[0] === "/v1/reserve");
    expect((reserveCall!.body as { run: { seconds: number | null } }).run.seconds).toBe(30);
  });

  it("a length the composer read for the clip (params.sourceDuration) is the clip's length too", () => {
    const req = { ...motionLite(), inputs: { images: [picture], video: "https://example.com/elsewhere.mp4" }, params: { resolution: "480p", sourceDuration: 12.5 } };
    expect(clipRunSeconds(req, "motion-transfer", { modelId: req.modelId, providerId: "comfyui", workflow: "wan-animate2" })).toBe(12.5);
  });

  it("a stated length never stands for the length of a clip whose header is read", () => {
    expect(factsOf({ ...motionLite(), params: { resolution: "480p", sourceDuration: 3, extra: { steps: 4 } } }).seconds).toBe(30);
  });

  it("a length the graph doesn't make (a default left in the request) doesn't stand for the clip's", () => {
    expect(factsOf({ ...motionLite(), params: { resolution: "480p", duration: 5 } }).seconds).toBe(30);
  });

  it("the canvas follows the driving clip's shape", () => {
    // 1280 × 720 at 480p: Wan Animate's landscape canvas, not the picture's.
    expect(factsOf(motionLite()).megapixels).toBe(0.41);
  });

  it("a clip edit (v2v) and a character swap get the clip's length", () => {
    const v2v = factsOf({ feature: "video", modelId: "fuobe-genjutsu-restyle", op: "v2v", prompt: "oil paint", inputs: { video: clip30 }, params: { resolution: "480p" } });
    expect(v2v).toMatchObject({ op: "v2v", seconds: 30 });
    const swap = factsOf({ feature: "video", modelId: "fuobe-genjutsu-swap", op: "video-swap", prompt: "the dancer", inputs: { images: [picture], video: clip30 }, params: { resolution: "480p" } });
    expect(swap).toMatchObject({ op: "video-swap", seconds: 30 });
    // From a start time, the part from there to the clip's end (the swap's graph cuts the clip there).
    const later = factsOf({ feature: "video", modelId: "fuobe-genjutsu-swap", op: "video-swap", prompt: "the dancer", inputs: { images: [picture], video: clip30 }, params: { resolution: "480p", startTime: 10 } });
    expect(later.seconds).toBe(20);
  });

  it("a length the request asks for, where the run makes it, is kept", () => {
    const swap = factsOf({ feature: "video", modelId: "fuobe-genjutsu-swap", op: "video-swap", prompt: "the dancer", inputs: { images: [picture], video: clip30 }, params: { resolution: "480p", duration: 4 } });
    expect(swap.seconds).toBe(4);
    const t2v = factsOf({ feature: "video", modelId: "oss-wan22-14b-fast", op: "t2v", prompt: "a fox", params: { duration: 3 } });
    expect(t2v.seconds).toBe(3);
  });

  it("a picture run stays without seconds", () => {
    const req: GenerationRequest = { feature: "image", modelId: "oss-z-image-turbo", prompt: "a fox" };
    const planned = runOnPool(a, () => previewGeneration(req));
    expect(runOnPool(a, () => runFacts(req, planned, "image")).seconds).toBeNull();
  });

  it("another account's clip reads as unknown, never as its length", () => {
    const other = auth.createAccount("other@example.com", "long enough").id;
    const req = motionLite();
    const seconds = runOnPool(other, () => clipRunSeconds(req, "motion-transfer", { modelId: req.modelId, providerId: "comfyui", workflow: "wan-animate2" }));
    expect(seconds).toBeNull();
  });
});
