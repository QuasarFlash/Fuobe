import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { startFakeBilling, type FakeBilling } from "./helpers/fake-billing";
import { tempDir } from "./helpers/temp-dir";

/**
 * The smart order of the line on this install's GPUs (src/server/computer/pool.ts smartLine): rounds over people, each
 * person's fastest run in their turn, and in each round people watching their runs, then by priority, then people with
 * no finished run yet, then everyone else; runs that waited 20 minutes first; a run that failed once at the very back
 * with one more try once the line is free; recoveries keep their place; a run only one GPU can make goes to that GPU
 * first; the owner's own jobs last; the owner's controls on top. And where its facts come from: who is watching (the
 * reads an open page makes), the priority the billing service gives, and the owner's Queue page's words.
 */

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.setConfig({ testTimeout: 60_000 });

const dir = tempDir("fuobe-pool-smart-queue-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:7";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
for (const k of ["FUOBE_PASSWORD", "FUOBE_HOSTED_RUNS", "FUOBE_HOSTED_FREE", "FUOBE_BILLING_URL", "FUOBE_BILLING_TOKEN", "FUOBE_MODERATION_URL"]) delete process.env[k];
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
const { proxy } = await import("@/proxy");
const { db } = await import("@/server/db");
const { resetRates } = await import("@/server/rate");
const { setSetting } = await import("@/server/settings");
const { getGeneration } = await import("@/server/generations");
const tasks = await import("@/server/computer/tasks");
const pool = await import("@/server/computer/pool");
const qc = await import("@/server/computer/queue-controls");
const watching = await import("@/server/computer/watching");
const { liveQueue } = await import("@/server/computer/queue-live");
const { catalogVersion } = await import("@/server/computer/catalog-version");
const billing = await import("@/server/billing");
const qs = await import("@/server/queue-settings");
const { heldStamp } = await import("@/server/hosted-run");
const { cleanPriority } = await import("@/lib/run-priority");
const { loadManifest } = await import("@/server/providers/comfyui");
const { loadIndex } = await import("@/server/gpu/index-file");
const { allLanes } = await import("@/lib/lanes");

type TaskRow = import("@/server/computer/tasks").TaskRow;
type WorkerRow = import("@/server/computer/workers").WorkerRow;

const HOST = "localhost:3000";
const SITE_HEADERS = { host: HOST, "sec-fetch-site": "same-origin", origin: `http://${HOST}` };
const MIN = 60_000;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const LANES = allLanes(loadIndex(), sha).map((l) => l.lane);
/** A quick lane and a slow one, as the stand-in workers' benches say. */
const QUICK = LANES[0];
const SLOW = LANES[1];

let fake: FakeBilling;
let accountId = "";
let cookie = "";

beforeAll(async () => {
  fake = await startFakeBilling();
  allowed = [fake.url];
  auth.setPassword("install password");
  accountId = auth.createAccount("smart-queue@example.com", "long enough").id;
  cookie = `${auth.SESSION_COOKIE}=${auth.createSession(accountId).value}`;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  globalThis.__fuobeTestDiskFree = undefined;
  for (const k of ["FUOBE_HOSTED_RUNS", "FUOBE_HOSTED_FREE", "FUOBE_BILLING_URL", "FUOBE_BILLING_TOKEN"]) delete process.env[k];
  await fake.close();
});
beforeEach(() => {
  resetRates();
  billing.resetBillingCache();
  qs.saveQueueSettings(qs.QUEUE_DEFAULTS);
  process.env.FUOBE_HOSTED_RUNS = "1";
  process.env.FUOBE_HOSTED_FREE = "1";
  delete process.env.FUOBE_BILLING_URL;
  delete process.env.FUOBE_BILLING_TOKEN;
  fake.reserveExtra = {};
  setSetting("comfyWhere", "workers");
  setSetting("comfyUrl", "");
  setSetting("engineMode", "open");
  setSetting("demoMode", "off");
  db().prepare("DELETE FROM relay_workers").run();
  db().prepare("DELETE FROM relay_watching").run();
  db().prepare("DELETE FROM queue_overrides").run();
  globalThis.__fuobeWatchNoted = undefined;
  db().prepare("UPDATE relay_tasks SET state = 'canceled' WHERE state != 'canceled'").run();
  db().prepare("UPDATE generations SET status = 'canceled' WHERE status IN ('queued', 'running')").run();
});

/** A stand-in worker that beat a moment ago: the lanes it is allowed (all by default), with a bench that makes QUICK quick and SLOW slow. */
function standInWorker(name = "stand-in", o: { lanes?: string[]; bench?: Record<string, number> } = {}) {
  const w = pool.addWorker(name);
  const lanes = o.lanes ?? LANES;
  pool.patchWorker(w.id, { paused: false, hours: { always: true }, allow: Object.fromEntries(lanes.map((l) => [l, { delayMs: 0 }])), claimAfterMs: 0 });
  const bench = o.bench ?? { [QUICK]: 5_000, [SLOW]: 300_000 };
  db()
    .prepare("UPDATE relay_workers SET lanes_json = ?, facts_json = ?, catalog_version = ?, protocol = 3, bench_json = ?, seen_at = ?, paused_local = 0 WHERE id = ?")
    .run(
      JSON.stringify({ lanes: LANES, workflows: loadManifest().workflows.map((x) => x.id) }),
      JSON.stringify({ vramBytes: 96 * 2 ** 30 }),
      catalogVersion(),
      JSON.stringify(Object.fromEntries(Object.entries(bench).map(([l, ms]) => [l, { medianMs: ms, p90Ms: ms }]))),
      Date.now(),
      w.id,
    );
  return w;
}
const workerRow = (w: { id: string }) => db().prepare("SELECT * FROM relay_workers WHERE id = ?").get(w.id) as WorkerRow;
const beatAs = (w: { id: string }, now = Date.now()) =>
  pool.workerBeat(workerRow(w), pool.cleanBeat({ device: `wkr-${w.id}`, protocol: 3, version: "1", local: { paused: false, why: null, until: null }, gpu: {}, inventoryHash: null, running: [], stopped: [], catalogVersion: catalogVersion() }), now);
const claimAs = (w: { id: string }, now = Date.now()) => {
  beatAs(w, now);
  return pool.workerClaim(workerRow(w), [], now);
};
const rowOf = (id: string) => db().prepare("SELECT * FROM relay_tasks WHERE id = ?").get(id) as TaskRow;
const done = (id: string) => db().prepare("UPDATE relay_tasks SET state = 'done', finished_at = ? WHERE id = ?").run(Date.now(), id);
const waiting = () => db().prepare("SELECT * FROM relay_tasks WHERE state = 'waiting' AND pools IS NOT NULL").all() as TaskRow[];
/** The line as a whole, in its order (the order a place in line reads). */
const line = (now = Date.now()) => pool.lineOrder(waiting(), "people-first", { now }).map((t) => t.id);

let n = 0;
/** A person of their own for one test (people keep their finished runs across tests). */
const person = (name: string) => `${name}-${++n}`;
/** A finished run of this person on the GPUs, long ago: they no longer count as new. */
const finishedBefore = (...accounts: string[]) => {
  for (const a of accounts) db().prepare("INSERT INTO worker_jobs (at, event, task_id, generation_id, principal) VALUES (?, 'done', ?, ?, ?)").run(Date.now() - 24 * 60 * MIN, `t-${a}`, `g-${a}`, `acct:${a}`);
};
const watch = (...accounts: string[]) => {
  for (const a of accounts) watching.noteWatching(a);
};

let gens = 0;
/** A task in the line: a person's (`account`) or the owner's own job, made `agoMs` ago, in a lane, with a priority. */
function lineTask(o: { account?: string; agoMs?: number; lane?: string; priority?: number; class?: "paid" | "free" } = {}) {
  const gid = `smart-gen-${++gens}`;
  const at = Date.now() - (o.agoMs ?? 0);
  db()
    .prepare("INSERT INTO generations (id, feature, model_id, engine, provider, op, kind, status, request_json, outputs_json, created_at, updated_at) VALUES (?, 'image', 'm', 'open', 'comfyui', 't2i', 'image', 'queued', ?, '[]', ?, ?)")
    .run(gid, JSON.stringify(o.account ? { account: o.account, place: "pool" } : { source: "batch" }), at, at);
  const t = tasks.createTask({
    principal: o.account ? `acct:${o.account}` : "owner",
    generationId: gid,
    graph: { "1": { class_type: "SaveImage", inputs: { filename_prefix: "x" } } },
    pool: { pools: ["pool"], account: o.account, class: o.account ? (o.class ?? "free") : "owner", priority: o.priority, rankAt: at, lane: o.lane ?? QUICK, needs: { workflowId: loadManifest().workflows[0].id, files: [], packs: [], minVramBytes: 0 } },
  });
  db().prepare("UPDATE relay_tasks SET created_at = ? WHERE id = ?").run(at, t.id);
  return t.id;
}

/** Every waiting task, claimed one by one by a worker that finishes each at once: the order it serves them. */
function served(w: { id: string }): string[] {
  const out: string[] = [];
  for (;;) {
    const t = claimAs(w);
    if (!t) return out;
    out.push(t.id);
    done(t.id);
  }
}

describe("rounds over people", () => {
  it("in each round: watching, then by priority, then a first run, then everyone else", () => {
    const w = standInWorker();
    const [W, P2, P1, F, E] = [person("watcher"), person("max"), person("pro"), person("new"), person("else")];
    finishedBefore(W, P2, P1, E);
    watch(W);
    // In the order they came alone, the last of them would go first.
    const e = lineTask({ account: E, agoMs: 5 * MIN });
    const f = lineTask({ account: F, agoMs: 4 * MIN });
    const p1 = lineTask({ account: P1, agoMs: 3 * MIN, priority: 1 });
    const p2 = lineTask({ account: P2, agoMs: 2 * MIN, priority: 2 });
    const wa = lineTask({ account: W, agoMs: 1 * MIN });
    expect(line()).toEqual([wa, p2, p1, f, e]);
    expect(pool.placeInLine(rowOf(wa)).place).toBe(1);
    expect(pool.placeInLine(rowOf(e)).place).toBe(5);
    expect(served(w)).toEqual([wa, p2, p1, f, e]);
  });

  it("a watcher with four quick runs takes one turn a round: the others' runs come in the first round", () => {
    const w = standInWorker();
    const [A, B, C] = [person("watcher"), person("pro"), person("free")];
    watch(A);
    const a = [1, 2, 3, 4].map((i) => lineTask({ account: A, agoMs: (10 - i) * 1000 }));
    const b = lineTask({ account: B, agoMs: 5000, priority: 1 });
    const c = lineTask({ account: C, agoMs: 4000 });
    expect(line()).toEqual([a[0], b, c, a[1], a[2], a[3]]);
    expect(served(w)).toEqual([a[0], b, c, a[1], a[2], a[3]]);
  });

  it("two watchers, one with four quick runs and one with one slow run: the slow run comes second, not fifth", () => {
    const w = standInWorker();
    const [W1, W2] = [person("quick"), person("slow")];
    watch(W1, W2);
    const quick = [1, 2, 3, 4].map((i) => lineTask({ account: W1, agoMs: (10 - i) * 1000, lane: QUICK }));
    const slow = lineTask({ account: W2, agoMs: 2000, lane: SLOW });
    expect(line()).toEqual([quick[0], slow, quick[1], quick[2], quick[3]]);
    expect(served(w)).toEqual([quick[0], slow, quick[1], quick[2], quick[3]]);
  });

  it("a person with a priority and a person with none, three runs each: they alternate, the priority first in each round", () => {
    const w = standInWorker();
    const [M, F] = [person("max"), person("free")];
    finishedBefore(M, F);
    const f = [1, 2, 3].map((i) => lineTask({ account: F, agoMs: (10 - i) * 1000 }));
    const m = [1, 2, 3].map((i) => lineTask({ account: M, agoMs: (5 - i) * 1000, priority: 2 }));
    expect(line()).toEqual([m[0], f[0], m[1], f[1], m[2], f[2]]);
    expect(served(w)).toEqual([m[0], f[0], m[1], f[1], m[2], f[2]]);
  });

  it("each person's turn takes their fastest run for the worker that asks; within a level, who waited longest goes first", () => {
    const w = standInWorker();
    const [A, B] = [person("a"), person("b")];
    const aSlow = lineTask({ account: A, agoMs: 3 * MIN, lane: SLOW });
    const aQuick = lineTask({ account: A, agoMs: 1 * MIN, lane: QUICK });
    const b = lineTask({ account: B, agoMs: 2 * MIN, lane: SLOW });
    // A waited longest: A's quickest first, then B's, then A's slow one.
    expect(line()).toEqual([aQuick, b, aSlow]);
    // On a worker where that lane is the slow one, A's other run is the quicker.
    const other = standInWorker("reversed", { bench: { [QUICK]: 300_000, [SLOW]: 5_000 } });
    expect(pool.lineOrder(waiting(), "people-first", { worker: workerRow(other), workers: [workerRow(other)] }).map((t) => t.id)).toEqual([aSlow, b, aQuick]);
    db().prepare("DELETE FROM relay_workers WHERE id = ?").run(other.id);
    expect(served(w)).toEqual([aQuick, b, aSlow]);
  });

  it("a run a worker holds for a person now is their turn this round", () => {
    const w1 = standInWorker("w1");
    const w2 = standInWorker("w2");
    const [A, B] = [person("a"), person("b")];
    finishedBefore(A, B);
    const a1 = lineTask({ account: A, agoMs: 5000 });
    const a2 = lineTask({ account: A, agoMs: 4000 });
    const b1 = lineTask({ account: B, agoMs: 1000 });
    expect(claimAs(w1)?.id).toBe(a1);
    // A's first run is being made: B's turn comes before A's second.
    expect(line()).toEqual([b1, a2]);
    expect(claimAs(w2)?.id).toBe(b1);
  });

  it("paid credits without a priority stand with everyone else: the class orders nothing", () => {
    const w = standInWorker();
    const [P, F] = [person("paid"), person("free")];
    finishedBefore(P, F);
    const f = lineTask({ account: F, agoMs: 3000 });
    const p = lineTask({ account: P, agoMs: 1000, class: "paid" });
    expect(served(w)).toEqual([f, p]);
  });
});

describe("waiting 20 minutes", () => {
  it("a run that waited 20 minutes goes to the front, the oldest first; at 19 minutes it waits its turn", () => {
    const w = standInWorker();
    const [W, E, G] = [person("watcher"), person("else"), person("older")];
    finishedBefore(E, G);
    watch(W);
    const now = Date.now();
    const quick = [1, 2].map((i) => lineTask({ account: W, agoMs: i * 1000 }));
    const e = lineTask({ account: E, agoMs: 19 * MIN, lane: SLOW });
    expect(line(now)).toEqual([quick[1], e, quick[0]]);
    // A minute later it has waited 20: to the front.
    expect(line(now + MIN + 1000)).toEqual([e, quick[1], quick[0]]);
    // Two that waited: the oldest first, whatever their people.
    const g = lineTask({ account: G, agoMs: 25 * MIN, lane: SLOW });
    expect(line(now + MIN + 1000)).toEqual([g, e, quick[1], quick[0]]);
    expect(served(w).slice(0, 1)).toEqual([g]);
  });
});

describe("recoveries", () => {
  it("keep their place: a worker that went silent, and a run given back for memory, wait where they were, with nothing failed", () => {
    const w = standInWorker();
    const [A, B] = [person("a"), person("b")];
    const a = lineTask({ account: A, agoMs: 5 * MIN });
    expect(claimAs(w)?.id).toBe(a);
    const b = lineTask({ account: B, agoMs: 1 * MIN });
    // Its worker goes quiet: back in line, at its place.
    db().prepare("UPDATE relay_workers SET seen_at = ? WHERE id = ?").run(Date.now() - 10 * MIN, w.id);
    pool.sweepPool();
    expect(rowOf(a)).toMatchObject({ state: "waiting", requeues: 1, failed_once: 0 });
    expect(line()).toEqual([a, b]);
    expect(pool.placeInLine(rowOf(a)).place).toBe(1);
    // A run given back by a worker that can't make its clips: the same.
    const c = claimAs(w)!;
    expect(c.id).toBe(a);
    tasks.report(rowOf(a), { event: "sent", promptId: c.promptId }, () => ({ error: "unused" }));
    tasks.report(rowOf(a), { event: "give-back", why: "media" }, () => ({ error: "unused" }));
    expect(rowOf(a)).toMatchObject({ state: "waiting", requeues: 2, failed_once: 0 });
    expect(line()).toEqual([a, b]);
  });
});

describe("best GPU for the job", () => {
  it("a worker takes a run only it can make before one another GPU could; with no other GPU on, it follows the order", () => {
    const big = standInWorker("big");
    const small = standInWorker("small", { lanes: [QUICK] });
    const [A, B] = [person("a"), person("b")];
    const q = lineTask({ account: A, agoMs: 3 * MIN, lane: QUICK });
    const s = lineTask({ account: B, agoMs: 1 * MIN, lane: SLOW });
    expect(line()).toEqual([q, s]);
    // Only the big worker can make B's run: it takes that one; the small one takes A's.
    expect(claimAs(big)?.id).toBe(s);
    expect(claimAs(small)?.id).toBe(q);
    done(s);
    done(q);
    // The small worker is off: the big one follows the order.
    const q2 = lineTask({ account: A, agoMs: 3 * MIN, lane: QUICK });
    const s2 = lineTask({ account: B, agoMs: 1 * MIN, lane: SLOW });
    db().prepare("UPDATE relay_workers SET seen_at = ? WHERE id = ?").run(Date.now() - 10 * MIN, small.id);
    expect(claimAs(big)?.id).toBe(q2);
    done(q2);
    done(s2);
    // A run the owner sent next goes first all the same.
    beatAs(small);
    const q3 = lineTask({ account: A, agoMs: 3 * MIN, lane: QUICK });
    lineTask({ account: B, agoMs: 1 * MIN, lane: SLOW });
    const o = qc.checkOverride({ kind: "run", generationId: rowOf(q3).generation_id, action: "next" });
    if ("error" in o) throw new Error(o.error);
    qc.addOverride(o, "owner");
    expect(claimAs(big)?.id).toBe(q3);
  });
});

describe("the owner's own jobs and the owner's controls", () => {
  it("runs sent next, boosted people and holds still work on top of the order", () => {
    const w = standInWorker();
    const [W, E] = [person("watcher"), person("else")];
    finishedBefore(E);
    watch(W);
    const wa = lineTask({ account: W, agoMs: 1000 });
    const e = lineTask({ account: E, agoMs: 2000 });
    const owner = lineTask({ agoMs: 60 * MIN });
    const add = (body: unknown) => {
      const o = qc.checkOverride(body);
      if ("error" in o) throw new Error(o.error);
      const r = qc.addOverride(o, "owner");
      if ("error" in r) throw new Error(r.error);
    };
    expect(line()).toEqual([wa, e, owner]);
    add({ kind: "run", generationId: rowOf(owner).generation_id, action: "next" });
    add({ kind: "person", account: E, action: "boost", forMin: 30 });
    add({ kind: "person", account: W, action: "hold" });
    expect(pool.placeInLine(rowOf(owner)).place).toBe(1);
    expect(pool.placeInLine(rowOf(e)).place).toBe(2);
    expect(served(w)).toEqual([owner, e]);
    expect(rowOf(wa).state).toBe("waiting");
  });
});

describe("who is watching", () => {
  it("an account's page that reads its runs counts as watching for 60 seconds; other reads, guests and the owner don't", async () => {
    const at = Date.now();
    const ask = (path: string, c?: string) => proxy(new NextRequest(`http://${HOST}${path}`, { method: "GET", headers: { host: HOST, ...(c && { cookie: c }) } }));
    await ask("/api/models", cookie);
    expect(watching.watchingNow(at).has(accountId)).toBe(false);
    await ask("/api/generations?statuses=queued,running&steps=1&limit=100", cookie);
    expect(watching.watchingNow().has(accountId)).toBe(true);
    expect(watching.watchingNow(Date.now() + 59_000).has(accountId)).toBe(true);
    expect(watching.watchingNow(Date.now() + 61_000).has(accountId)).toBe(false);
    // The reads that follow runs: the list, one run, its live picture; not the Library's counts, the Trash or a zip.
    for (const p of ["/api/generations", "/api/generations/g-1", "/api/generations/g-1/preview"]) expect(watching.followsRuns("GET", p), p).toBe(true);
    for (const p of ["/api/generations/facets", "/api/generations/trash", "/api/generations/zip", "/api/generations/g-1/cancel", "/api/models"]) expect(watching.followsRuns("GET", p), p).toBe(false);
    expect(watching.followsRuns("POST", "/api/generations")).toBe(false);
    await ask("/api/generations");
    expect([...watching.watchingNow()]).toEqual([accountId]);
  });

  it("is written at most every 15 seconds for one account", () => {
    const at = Date.now();
    watching.noteWatching("acct-throttle", at);
    watching.noteWatching("acct-throttle", at + 10_000);
    const seen = () => (db().prepare("SELECT seen_at FROM relay_watching WHERE account = ?").get("acct-throttle") as { seen_at: number }).seen_at;
    expect(seen()).toBe(at);
    watching.noteWatching("acct-throttle", at + 16_000);
    expect(seen()).toBe(at + 16_000);
  });
});

describe("priority from the billing service", () => {
  it("is a whole number from 0 to 9: out of range is the nearest, anything else 0", () => {
    expect([0, 1, 2, 9, 12, -3, 2.7, Number.NaN, Infinity].map(cleanPriority)).toEqual([0, 1, 2, 9, 9, 0, 2, 0, 0]);
    for (const v of ["2", null, undefined, {}, true]) expect(cleanPriority(v)).toBe(0);
    const ok = { ok: true as const, holdId: "h", amount: 0, boostMs: 0, maxWaitMs: 0, text: "" };
    expect(heldStamp({ ...ok, priority: 2 }, undefined).priority).toBe(2);
    expect(heldStamp({ ...ok, priority: 40 }, undefined).priority).toBe(9);
    expect(heldStamp({ ...ok, priority: 0 }, undefined)).not.toHaveProperty("priority");
    expect(heldStamp(ok, undefined)).not.toHaveProperty("priority");
  });

  it("an account's run takes the priority the reserve answer gives, kept on the run, and the browser never sees it", async () => {
    standInWorker();
    process.env.FUOBE_BILLING_URL = fake.url;
    process.env.FUOBE_BILLING_TOKEN = "test-billing-token";
    fake.policy = { ...fake.policy, hosted: true, ttlS: 0 };
    fake.reserveExtra = { class: "paid", priority: 2 };
    const r = await generationsRoute.POST(
      new Request(`http://${HOST}/api/generations`, {
        method: "POST",
        headers: { ...SITE_HEADERS, cookie, "content-type": "application/json" },
        body: JSON.stringify({ feature: "image", modelId: "oss-z-image-turbo", prompt: "a lighthouse", shown: { amount: 7, priceVersion: "v7" } }),
      }),
    );
    const body = (await r.json()) as { items?: { id: string }[] };
    expect(r.status, JSON.stringify(body)).toBe(201);
    const id = body.items![0].id;
    const taskOf = () => db().prepare("SELECT * FROM relay_tasks WHERE generation_id = ? ORDER BY created_at DESC").get(id) as TaskRow | undefined;
    let t = taskOf();
    for (let i = 0; i < 100 && !t; i++) {
      await globalThis.__fuobeRunner?.tick();
      await new Promise((res) => setTimeout(res, 20));
      t = taskOf();
    }
    expect(t).toMatchObject({ class: "paid", priority: 2 });
    const stored = JSON.parse((db().prepare("SELECT request_json FROM generations WHERE id = ?").get(id) as { request_json: string }).request_json) as Record<string, unknown>;
    expect(stored.priority).toBe(2);
    expect(pool.runPlaceOf(id)?.priority).toBe(2);
    expect((getGeneration(id) as unknown as { request?: Record<string, unknown> }).request?.priority).toBeUndefined();
  });
});

describe("the owner's Queue page", () => {
  it("says why each run stands where it does; the person reading their run sees none of it", () => {
    const big = standInWorker("big");
    standInWorker("small", { lanes: [QUICK] });
    const [W, P, F, E, G, S, O] = [person("watcher"), person("pro"), person("new"), person("else"), person("older"), person("failed"), person("only")];
    finishedBefore(W, P, E, G, S, O);
    watch(W);
    const ids = {
      aged: lineTask({ account: G, agoMs: 25 * MIN }),
      watching: lineTask({ account: W, agoMs: 1000 }),
      priority: lineTask({ account: P, agoMs: 2000, priority: 1 }),
      first: lineTask({ account: F, agoMs: 3000 }),
      turn: lineTask({ account: E, agoMs: 5000 }),
      only: lineTask({ account: O, agoMs: 4000, lane: SLOW }),
      second: lineTask({ account: S, agoMs: 6000 }),
      owner: lineTask({ agoMs: 60 * MIN }),
    };
    db().prepare("UPDATE relay_tasks SET failed_once = 1 WHERE id = ?").run(ids.second);
    const q = liveQueue().queued;
    const why = (id: string) => q.find((x) => x.task === id)?.why;
    expect(why(ids.aged)).toBe("Waited 20 min");
    expect(why(ids.watching)).toBe("Watching");
    expect(why(ids.priority)).toBe("Plan priority");
    expect(why(ids.first)).toBe("First run");
    expect(why(ids.turn)).toBe("Fastest of theirs");
    expect(why(ids.only)).toBe("Only this GPU can make it");
    expect(why(ids.second)).toBe("Second try when the line is free");
    expect(why(ids.owner)).toBe("Our work: after people's runs");
    expect(q.map((x) => x.task)).toEqual([ids.aged, ids.watching, ids.priority, ids.first, ids.turn, ids.only, ids.second, ids.owner]);
    expect(q.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // The big worker, the only one that makes the slow lane, takes that run first.
    expect(claimAs(big)?.id).toBe(ids.only);
    const words = /Watching|Plan priority|First run|Fastest of theirs|Waited 20 min|Second try|Only this GPU/;
    for (const id of Object.values(ids)) expect(JSON.stringify(getGeneration(rowOf(id).generation_id))).not.toMatch(words);
  });
});
