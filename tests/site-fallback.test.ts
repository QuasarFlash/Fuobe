import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeBilling, FAKE_POLICY, type FakeBilling } from "./helpers/fake-billing";
import { startFakeComfy, type FakeComfy } from "./helpers/fake-comfy-runner";
import { tempDir } from "./helpers/temp-dir";

/**
 * "Run on {Place} automatically when your GPU can't" (hosted runs): the account's answer, kept once on the server; a run
 * that fails on its own GPU for a GPU's reason made again by the server on this install's GPUs (through the account's own
 * Run, linked both ways, once), never for the person's own files and never twice; a run they won't take left as it was;
 * and a run sent while its GPU doesn't answer going there instead of asking. A stand-in ComfyUI as the account's GPU, a
 * stand-in worker as this install's GPUs.
 */

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.setConfig({ testTimeout: 60_000 });

const dir = tempDir("fuobe-site-fallback-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:7";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_ALLOW_PRIVATE_URLS;
delete process.env.FUOBE_BILLING_URL;
delete process.env.FUOBE_MODERATION_URL;
globalThis.__fuobeTestDiskFree = 1e13;

const realFetch = globalThis.fetch;
let allowed: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (allowed.some((a) => url.startsWith(a))) return realFetch(input, init);
  return new Response("not reachable in this test", { status: 599 });
}) as typeof fetch;

const auth = await import("@/server/auth");
const generationsRoute = await import("@/app/api/generations/route");
const fallbackRoute = await import("@/app/api/account/site-fallback/route");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { setSetting } = await import("@/server/settings");
const pool = await import("@/server/computer/pool");
const { catalogVersion } = await import("@/server/computer/catalog-version");
const billing = await import("@/server/billing");
const { visitorStatus } = await import("@/server/account-gpu");
const { loadManifest } = await import("@/server/providers/comfyui");
const { loadIndex } = await import("@/server/gpu/index-file");
const { allLanes } = await import("@/lib/lanes");
const { PLACE_ASK_HEADER } = await import("@/lib/guest-access");
const { getGeneration, SELF_HEAL } = await import("@/server/generations");
const fallback = await import("@/server/site-fallback");
const { sendToSite } = await import("@/server/site-fallback-run");

const HOST = "localhost:3000";
const SITE_HEADERS = { host: HOST, "sec-fetch-site": "same-origin", origin: `http://${HOST}` };
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const IMAGE = { feature: "image", modelId: "oss-z-image-turbo", prompt: "a lighthouse at dusk", params: { aspectRatio: "16:9", seed: 3 } };

let fake: FakeBilling;
let comfy: FakeComfy;
let n = 0;

/** A new account with its own GPU (the stand-in ComfyUI), and its cookie. */
function account(o: { gpu?: boolean } = { gpu: true }) {
  const a = auth.createAccount(`fallback-${++n}@example.com`, "long enough");
  if (o.gpu) auth.setAccountGpu(a.id, { url: comfy.url });
  return { id: a.id, cookie: `${auth.SESSION_COOKIE}=${auth.createSession(a.id).value}` };
}

const post = async (body: Record<string, unknown>, cookie: string) => {
  const text = JSON.stringify(body);
  const r = await generationsRoute.POST(
    new Request(`http://${HOST}/api/generations`, { method: "POST", headers: { ...SITE_HEADERS, cookie, "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }, body: text }),
  );
  return { status: r.status, headers: r.headers, body: (await r.json()) as { items?: { id: string; place?: string }[]; code?: string; error?: string } };
};
const answer = async (cookie: string, method: "GET" | "PUT", body?: unknown) => {
  const r = await fallbackRoute[method](
    new Request(`http://${HOST}/api/account/site-fallback`, { method, headers: { ...SITE_HEADERS, cookie, "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) }),
  );
  return { status: r.status, body: (await r.json()) as { siteFallback?: string | null } };
};

/** A worker as the owner adds it, connected once (this install's GPUs). */
function standInWorker() {
  const w = pool.addWorker(`stand-in-${++n}`);
  const lanes = allLanes(loadIndex(), sha);
  pool.patchWorker(w.id, { paused: false, hours: { always: true }, allow: Object.fromEntries(lanes.map((l) => [l.lane, { delayMs: 0 }])), claimAfterMs: 0 });
  db()
    .prepare("UPDATE relay_workers SET lanes_json = ?, facts_json = ?, catalog_version = ?, protocol = 3 WHERE id = ?")
    .run(JSON.stringify({ lanes: lanes.map((l) => l.lane), workflows: loadManifest().workflows.map((x) => x.id) }), JSON.stringify({ vramBytes: 96 * 2 ** 30 }), catalogVersion(), w.id);
  db().prepare("UPDATE relay_workers SET seen_at = ?, paused_local = 0 WHERE id = ?").run(Date.now(), w.id);
  return w;
}

const withBilling = (policy: Record<string, unknown> = {}) => {
  process.env.FUOBE_BILLING_URL = fake.url;
  process.env.FUOBE_BILLING_TOKEN = "test-billing-token";
  fake.policy = { ...FAKE_POLICY, ...policy, limits: { ...FAKE_POLICY.limits, outputsPerRun: 4, ...((policy.limits as object) ?? {}) }, ttlS: 0 };
  billing.resetBillingCache();
};

/** The account's own GPU answers this run's job with an error from its node (`message`), as ComfyUI's history says it. */
const failsWith = (message: string) => (m: string, p: string) => {
  if (m !== "GET" || !p.startsWith("/history/")) return undefined;
  const id = decodeURIComponent(p.slice("/history/".length));
  const error = { prompt_id: id, node_id: "3", node_type: "KSampler", executed: [], exception_message: message, exception_type: "RuntimeError", traceback: [], current_inputs: {}, current_outputs: {} };
  return { status: 200, contentType: "application/json", body: JSON.stringify({ [id]: { prompt: [1, id, {}, {}, []], status: { status_str: "error", completed: false, messages: [["execution_start", {}], ["execution_error", error]] }, outputs: {} } }) };
};

/** Tick the runner until `ok` holds (or the time is up). */
async function until<T>(fn: () => T, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let v = fn();
  while (!v && Date.now() < end) {
    await globalThis.__fuobeRunner?.tick();
    await new Promise((r) => setTimeout(r, 20));
    v = fn();
  }
  return v;
}

/** A run of the account's on its own GPU, made through its Run. */
async function ownRun(cookie: string): Promise<string> {
  const r = await post({ ...IMAGE, place: "own" }, cookie);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.items![0].place).toBeUndefined();
  return r.body.items![0].id;
}

/** The run ended failed on its own GPU, with what it ran into (as the runner keeps it). */
function failOwn(id: string, cause: string): void {
  const trouble = { cause, words: "Your GPU ran into a problem.", actions: [{ kind: "retry", label: "Retry" }], retryable: false };
  db().prepare("UPDATE generations SET status = 'failed', error = ?, fix_json = ?, completed_at = ? WHERE id = ?").run(trouble.words, JSON.stringify({ trouble }), Date.now(), id);
}
const troubleOf = (cause: string) => ({ cause, actions: [] }) as never;

/** Runs on this install's GPUs an account has made. */
const poolRuns = (id: string) =>
  (db().prepare("SELECT COUNT(*) AS n FROM generations WHERE json_extract(request_json, '$.account') = ? AND json_extract(request_json, '$.place') = 'pool'").get(id) as { n: number }).n;

beforeAll(async () => {
  fake = await startFakeBilling();
  comfy = await startFakeComfy({ output: "image", delayMs: 0 });
  globalThis.__fuobeTestGpuPort = comfy.port;
  allowed = [fake.url];
  auth.setPassword("install password");
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestDiskFree = undefined;
  globalThis.__fuobeTestGpuPort = undefined;
  SELF_HEAL.scale = 1;
  for (const k of ["FUOBE_HOSTED_RUNS", "FUOBE_HOSTED_FREE", "FUOBE_BILLING_URL", "FUOBE_BILLING_TOKEN", "FUOBE_PUBLIC_SIGNUP"]) delete process.env[k];
  await fake.close();
  await comfy.close();
});
beforeEach(() => {
  resetRates();
  billing.resetBillingCache();
  SELF_HEAL.scale = 0.001;
  process.env.FUOBE_HOSTED_RUNS = "1";
  process.env.FUOBE_HOSTED_FREE = "1";
  delete process.env.FUOBE_BILLING_URL;
  delete process.env.FUOBE_BILLING_TOKEN;
  fake.policy = { ...FAKE_POLICY };
  fake.price = { amount: 7, version: "v7" };
  Object.assign(comfy.opts, { answer: undefined, delayMs: 0 });
  setSetting("comfyWhere", "workers");
  setSetting("comfyUrl", "");
  setSetting("engineMode", "open");
  setSetting("demoMode", "off");
  db().prepare("DELETE FROM relay_workers").run();
  db().prepare("UPDATE relay_tasks SET state = 'canceled' WHERE state IN ('waiting','sending','queued','running','collecting')").run();
  db().prepare("UPDATE generations SET status = 'canceled' WHERE status IN ('queued', 'running')").run();
  standInWorker();
});

describe("the account's answer", () => {
  it("is kept once on the server, Not now too, and can be changed; the status says it to that account only", async () => {
    const a = account();
    expect((await answer(a.cookie, "GET")).body.siteFallback).toBeNull();
    expect((await visitorStatus(auth.accountById(a.id)!)).viewer.siteFallback).toBeUndefined();
    // Not now: kept, so the question isn't asked again.
    expect((await answer(a.cookie, "PUT", { on: false })).body.siteFallback).toBe("off");
    expect(fallback.siteFallbackFor(a.id)).toBe("off");
    expect((await visitorStatus(auth.accountById(a.id)!)).viewer.siteFallback).toBe("off");
    expect(fallback.siteFallbackOn(a.id)).toBe(false);
    // Switched on later (Settings).
    expect((await answer(a.cookie, "PUT", { on: true })).body.siteFallback).toBe("on");
    expect(fallback.siteFallbackOn(a.id)).toBe(true);
    // Each account its own.
    expect(fallback.siteFallbackFor(account().id)).toBeUndefined();
    expect((await answer(a.cookie, "PUT", { on: "yes" })).status).toBe(400);
    // Off with hosted runs off: never on.
    delete process.env.FUOBE_HOSTED_RUNS;
    expect(fallback.siteFallbackOn(a.id)).toBe(false);
  });

  it("goes with a deleted account", () => {
    const a = account();
    fallback.setSiteFallback(a.id, true);
    fallback.clearSiteFallback(a.id);
    expect(fallback.siteFallbackFor(a.id)).toBeUndefined();
  });
});

describe("a run its own GPU couldn't make", () => {
  it("goes to this install's GPUs by itself when the account said yes: made by the server, linked both ways, once", async () => {
    const a = account();
    fallback.setSiteFallback(a.id, true);
    comfy.opts.answer = failsWith("CUDA error: out of memory");
    const id = await ownRun(a.cookie);
    // It fails on its own GPU (the runner's own path), and the server sends it on.
    const moved = await until(() => fallback.moveOf(id)?.state === "moved" && fallback.moveOf(id));
    expect(moved, JSON.stringify(fallback.moveOf(id))).toBeTruthy();
    const failed = getGeneration(id)!;
    expect(failed.status).toBe("failed");
    expect(failed.trouble?.cause).toBe("gpu-out-of-memory");
    const newId = (moved && moved.new_id) || "";
    expect(failed.movedTo).toBe(newId);
    expect(fallback.movedFromOf(newId)).toBe(id);
    // The new run: the same request, on this install's GPUs, going as any run there goes.
    const made = getGeneration(newId)!;
    expect(made.place).toBe("pool");
    expect(["queued", "running"]).toContain(made.status);
    expect(made.request).toMatchObject({ prompt: IMAGE.prompt, modelId: IMAGE.modelId, params: { aspectRatio: "16:9", seed: 3 } });
    expect(made.movedTo).toBeUndefined();
    // Never twice: a second claim of the same run takes nothing.
    expect(fallback.claimSiteFallback(id, a.id, troubleOf("gpu-out-of-memory"))).toBe(false);
    expect(poolRuns(a.id)).toBe(1);
  });

  it("is left as it was when the account hasn't said yes", async () => {
    const a = account();
    comfy.opts.answer = failsWith("CUDA error: out of memory");
    const id = await ownRun(a.cookie);
    const g = await until(() => getGeneration(id)?.status === "failed" && getGeneration(id));
    expect(g && g.trouble?.cause).toBe("gpu-out-of-memory");
    await new Promise((r) => setTimeout(r, 100));
    expect(fallback.moveOf(id)).toBeUndefined();
    expect(poolRuns(a.id)).toBe(0);
    // Not now: the same.
    fallback.setSiteFallback(a.id, false);
    expect(fallback.claimSiteFallback(id, a.id, troubleOf("gpu-out-of-memory"))).toBe(false);
  });

  it("only for its GPU's troubles: never the person's own files or a run they stopped", async () => {
    const a = account();
    fallback.setSiteFallback(a.id, true);
    for (const cause of ["bad-input", "content-flag", "gpu-too-big", "gpu-stopped-run", "key-balance"]) {
      const id = await ownRun(a.cookie);
      failOwn(id, cause);
      expect(fallback.claimSiteFallback(id, a.id, troubleOf(cause)), cause).toBe(false);
    }
    // No trouble kept at all (a run with nothing of its GPU's to say).
    const plain = await ownRun(a.cookie);
    failOwn(plain, "gpu-offline");
    expect(fallback.claimSiteFallback(plain, a.id, undefined)).toBe(false);
    expect(poolRuns(a.id)).toBe(0);
  });

  it("never moves a run on this install's GPUs, or one that was itself moved there", async () => {
    const a = account();
    fallback.setSiteFallback(a.id, true);
    const first = await ownRun(a.cookie);
    failOwn(first, "gpu-offline");
    expect(fallback.claimSiteFallback(first, a.id, troubleOf("gpu-offline"))).toBe(true);
    const made = await sendToSite(first, generationsRoute.POST);
    expect(made?.ids).toHaveLength(1);
    // The run made there fails too: it stays as it is (it ran on this install's GPUs).
    db().prepare("UPDATE generations SET status = 'failed' WHERE id = ?").run(made!.ids[0]);
    expect(fallback.claimSiteFallback(made!.ids[0], a.id, troubleOf("gpu-offline"))).toBe(false);
    // Even a run made that way that ended on its own GPU is never moved again.
    const other = await ownRun(a.cookie);
    failOwn(other, "gpu-offline");
    db().prepare("INSERT INTO site_fallback_runs (run_id, account_id, state, new_id, at) VALUES ('earlier-run', ?, 'moved', ?, ?)").run(a.id, other, Date.now());
    expect(fallback.claimSiteFallback(other, a.id, troubleOf("gpu-offline"))).toBe(false);
    // Another account's run is never claimed for this one.
    const b = account();
    fallback.setSiteFallback(b.id, true);
    const theirs = await ownRun(a.cookie);
    failOwn(theirs, "gpu-offline");
    expect(fallback.claimSiteFallback(theirs, b.id, troubleOf("gpu-offline"))).toBe(false);
  });

  it("is left as it was when this install's GPUs refuse it: its card keeps its own buttons", async () => {
    const a = account();
    fallback.setSiteFallback(a.id, true);
    // Closed to the account.
    withBilling({ hosted: false });
    const closed = await ownRun(a.cookie);
    failOwn(closed, "gpu-offline");
    expect(fallback.claimSiteFallback(closed, a.id, troubleOf("gpu-offline"))).toBe(true);
    expect(getGeneration(closed)!.moving).toBe(true);
    expect(await sendToSite(closed, generationsRoute.POST)).toBeNull();
    expect(fallback.moveOf(closed)?.state).toBe("refused");
    const g = getGeneration(closed)!;
    expect(g.movedTo).toBeUndefined();
    expect(g.moving).toBeUndefined();
    expect(g.trouble?.cause).toBe("gpu-offline");
    // A model the policy doesn't offer there.
    withBilling({ pool: { deny: ["oss-z-image-turbo"] } });
    const denied = await ownRun(a.cookie);
    failOwn(denied, "gpu-offline");
    expect(fallback.claimSiteFallback(denied, a.id, troubleOf("gpu-offline"))).toBe(true);
    expect(await sendToSite(denied, generationsRoute.POST)).toBeNull();
    expect(fallback.moveOf(denied)?.state).toBe("refused");
    // A limit: it would wait to enter the line, so it isn't made at all.
    withBilling({ limits: { activeRuns: 0, waiting: 5, runsPerHour: 1 } });
    const filler = await post({ ...IMAGE, place: "pool", shown: { amount: 7, priceVersion: "v7" } }, a.cookie);
    expect(filler.status, JSON.stringify(filler.body)).toBe(201);
    const before = poolRuns(a.id);
    const limited = await ownRun(a.cookie);
    failOwn(limited, "gpu-offline");
    expect(fallback.claimSiteFallback(limited, a.id, troubleOf("gpu-offline"))).toBe(true);
    expect(await sendToSite(limited, generationsRoute.POST)).toBeNull();
    expect(fallback.moveOf(limited)?.state).toBe("refused");
    expect(poolRuns(a.id)).toBe(before);
    // And never again for those runs.
    expect(fallback.claimSiteFallback(limited, a.id, troubleOf("gpu-offline"))).toBe(false);
  });
});

describe("a run sent while the account's own GPU doesn't answer", () => {
  it("is asked about without the answer, and goes to this install's GPUs with it", async () => {
    const a = account();
    // Its GPU doesn't answer.
    comfy.opts.answer = () => ({ status: 502, body: "<html>Bad gateway</html>", contentType: "text/html" });
    globalThis.__fuobeAccountGpus?.clear();
    const asked = await post(IMAGE, a.cookie);
    expect(asked.status, JSON.stringify(asked.body)).toBe(409);
    expect(asked.body.code).toBe("own-gpu-offline");
    expect(asked.headers.get(PLACE_ASK_HEADER)).toBe("1");
    expect(poolRuns(a.id)).toBe(0);
    fallback.setSiteFallback(a.id, true);
    const went = await post(IMAGE, a.cookie);
    expect(went.status, JSON.stringify(went.body)).toBe(201);
    expect(went.body.items![0].place).toBe("pool");
    expect(poolRuns(a.id)).toBe(1);
    // Not now: asked again.
    fallback.setSiteFallback(a.id, false);
    expect((await post(IMAGE, a.cookie)).body.code).toBe("own-gpu-offline");
  });
});
