import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import type { GenerationRequest } from "@/lib/catalog/types";
import { siteFallbackOf, siteRunRequest } from "@/lib/site-run";
import { accountInputProblem } from "./account-inputs";
import { accountById, accountRequest } from "./auth";
import { db } from "./db";
import { cancelGeneration, getGeneration } from "./generations";
import { poolReady } from "./hosted";
import { hostedRunsOn } from "./hosted-switch";
import { withoutStamp } from "./run-stamp";
import { moveOf, noteMoved, noteRefused } from "./site-fallback";

/**
 * A run its own GPU couldn't make, made again on this install's GPUs (site-fallback.ts claimed it as it failed): the same
 * request, sent as "Run on {Place}" sends it (src/lib/site-run.ts siteRunRequest), through the account's own Run (POST
 * /api/generations) as if its page had sent it. So it meets every check a press meets (the limits, the moderation and
 * billing services, the policy of this install's GPUs), priced and set aside the same way. Only a run taken into the line
 * there now counts: one refused, or one that would wait to enter the line (held), leaves the failed run as it was.
 */

/** The account's Run: the run route's POST (loaded when first needed, so this module never imports a route itself). */
export type SubmitRun = (request: Request) => Promise<Response>;

const accountsRun: SubmitRun = async (request) => (await import("@/app/api/generations/route")).POST(request);

/** Send the claimed move of failed run `id`. The run made for it (its ids), or null when it wasn't taken. */
export async function sendToSite(id: string, submit: SubmitRun = accountsRun): Promise<{ ids: string[] } | null> {
  let ids: string[] | null = null;
  try {
    ids = await send(id, submit);
  } catch (e) {
    console.warn(`[fuobe] A run couldn't move to this install's GPUs: ${(e as Error).message}`);
  }
  if (ids?.length) {
    noteMoved(id, ids[0]);
    return { ids };
  }
  noteRefused(id);
  return null;
}

async function send(id: string, submit: SubmitRun): Promise<string[] | null> {
  const move = moveOf(id);
  if (!move || move.state !== "sending") return null;
  if (!hostedRunsOn() || !poolReady()) return null;
  const account = accountById(move.account_id);
  if (!account || account.disabled) return null;
  const g = getGeneration(id);
  if (!g || g.status !== "failed") return null;
  const run = siteFallbackOf({ ...g, moving: undefined, movedTo: undefined }, true, undefined);
  if (!run) return null;
  const row = db().prepare("SELECT batch_id, request_json FROM generations WHERE id = ?").get(id) as { batch_id: string | null; request_json: string } | undefined;
  if (!row) return null;
  // The request as its page sent it (the server's stamp and the account are set again by the Run).
  const stored = JSON.parse(row.request_json) as GenerationRequest;
  const base = withoutStamp(stored) as GenerationRequest & Record<string, unknown>;
  delete base.account;
  let req = siteRunRequest({ request: base as GenerationRequest }, run) as GenerationRequest & Record<string, unknown>;
  // One job of a batch: its share of the outputs, not the whole batch's again.
  if (row.batch_id) {
    const jobs = db().prepare("SELECT COUNT(*) FROM generations WHERE batch_id = ? AND request_json = ? AND depends_on IS NULL").pluck().get(row.batch_id, row.request_json) as number;
    const asked = Math.max(1, Number(stored.params?.numOutputs) || 1);
    if (jobs > 1) req = { ...req, params: { ...req.params, numOutputs: Math.max(1, Math.ceil(asked / jobs)) } };
  }
  // Its files must still be here, and its own.
  if (accountInputProblem(req, account.id)) return null;

  const post = async (preview: boolean, extra: Record<string, unknown>) => {
    const text = JSON.stringify({ ...req, place: "pool", ...extra });
    const res = await submit(
      accountRequest(account, `http://localhost/api/generations${preview ? "?preview=1" : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: text }),
    );
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  // The price check its page would make first: taken there, into the line now (not refused, not waiting to enter it).
  const check = await post(true, {});
  const quote = check.json.quote as { allowed?: unknown; amount?: unknown; priceVersion?: unknown } | undefined;
  const line = check.json.line as { held?: unknown } | undefined;
  if (check.status !== 200 || check.json.place !== "pool" || quote?.allowed === false || line?.held) return null;
  const shown = quote && typeof quote.amount === "number" && typeof quote.priceVersion === "string" ? { amount: quote.amount, priceVersion: quote.priceVersion } : undefined;

  const made = await post(false, { requestId: crypto.randomUUID(), ...(shown && { shown }) });
  const items = Array.isArray(made.json.items) ? (made.json.items as { id?: unknown; place?: unknown }[]) : [];
  const ids = items.map((x) => x.id).filter((x): x is string => typeof x === "string");
  if (made.status !== 201 || !ids.length) return null;
  // Taken, but waiting to enter the line (a limit, or a service), or not on this install's GPUs after all: stopped again,
  // and the failed run keeps its own buttons.
  if (made.json.held || items.some((x) => x.place !== "pool")) {
    for (const newId of ids) await cancelGeneration(newId).catch(() => {});
    return null;
  }
  return ids;
}

declare global {
  /** The server's own context as it started (instrumentation.ts): no run's account, GPU or stamp in scope. */
  var __fuobeRootContext: (<R>(fn: () => R) => R) | undefined;
}

/** Keep the server's own context (called once as it starts), for work a run starts that must not run as that run. */
export function keepRootContext(): void {
  globalThis.__fuobeRootContext ??= AsyncLocalStorage.snapshot();
}

/**
 * generations.ts failRun's side: the move it claimed goes out now, without holding the failing run up (the person's page
 * may be closed: it is made all the same). Outside the failed run's own scope (its account's GPU, its stamp), as a press
 * from the page would be.
 */
export function sendSoon(id: string): void {
  const go = () => setTimeout(() => void sendToSite(id), 0);
  const root = globalThis.__fuobeRootContext;
  if (root) root(go);
  else go();
}
