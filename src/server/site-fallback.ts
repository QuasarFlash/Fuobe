import "server-only";
import type { RunTrouble } from "@/lib/diagnose";
import { siteFallbackOf as siteFallbackOfRun, type SiteFallback } from "@/lib/site-run";
import { db } from "./db";
import { hostedRunsOn } from "./hosted-switch";

/**
 * "Run on {Place} automatically when your GPU can't" (hosted runs only): the account's answer, asked once after its first
 * "Run on {Place}" on a run its own GPU couldn't make, and changeable in Settings → Where your runs go. With it on, a run
 * that fails on the account's own GPU for a GPU's reason (src/lib/site-run.ts siteFallbackOf) is made again on this
 * install's GPUs by the server, at once, through the account's own Run (site-fallback-run.ts), and a run sent while its
 * GPU doesn't answer goes there instead of asking (hosted-run.ts). Tables made in db.ts (SITE_FALLBACK_TABLES).
 *
 * Each failed run moves once: its row here is claimed as it fails ("sending"), and says the run made for it ("moved") or
 * that it wasn't taken ("refused": the failed run stays as it was, with its own buttons). A run made this way is never
 * moved again, and neither is a run on this install's GPUs.
 */

/** A move still "sending" this long after it was claimed (a server stopped in the middle) counts as not made. */
export const SENDING_MS = 2 * 60_000;

/** The account's answer: "on", "off" (Not now, or switched off), or undefined (never asked). */
export function siteFallbackFor(accountId: string): SiteFallback | undefined {
  const r = db().prepare("SELECT auto FROM account_site_fallback WHERE account_id = ?").get(accountId) as { auto: number } | undefined;
  return r ? (r.auto ? "on" : "off") : undefined;
}

/** Keep the account's answer (asked once: either answer counts as asked). */
export function setSiteFallback(accountId: string, on: boolean, now = Date.now()): void {
  db()
    .prepare(
      `INSERT INTO account_site_fallback (account_id, auto, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET auto = excluded.auto, updated_at = excluded.updated_at`,
    )
    .run(accountId, on ? 1 : 0, now);
}

/** Is it on for this account now (hosted runs on, and it said yes)? */
export const siteFallbackOn = (accountId: string): boolean => hostedRunsOn() && siteFallbackFor(accountId) === "on";

/** A deleted account's answer and its moves go with it. */
export function clearSiteFallback(accountId: string): void {
  db().prepare("DELETE FROM account_site_fallback WHERE account_id = ?").run(accountId);
  db().prepare("DELETE FROM site_fallback_runs WHERE account_id = ?").run(accountId);
}

type MoveState = "sending" | "moved" | "refused";

interface MoveRow {
  run_id: string;
  account_id: string;
  state: MoveState;
  new_id: string | null;
  at: number;
}

/** The move of failed run `id`, if one was claimed. */
export function moveOf(id: string): MoveRow | undefined {
  return db().prepare("SELECT * FROM site_fallback_runs WHERE run_id = ?").get(id) as MoveRow | undefined;
}

/** The failed run a run was made for (it went to this install's GPUs when its own GPU couldn't make it), if any. */
export function movedFromOf(newId: string): string | undefined {
  return (db().prepare("SELECT run_id FROM site_fallback_runs WHERE new_id = ?").pluck().get(newId) as string | undefined) ?? undefined;
}

/** A failed run's card fields (Generation.movedTo, Generation.moving): where it went, or that it is going. */
export function movedFields(id: string, now = Date.now()): { movedTo: string } | { moving: true } | Record<string, never> {
  const m = moveOf(id);
  if (!m) return {};
  if (m.state === "moved" && m.new_id) return { movedTo: m.new_id };
  if (m.state === "sending" && now - m.at < SENDING_MS) return { moving: true };
  return {};
}

/** The stored request's facts the claim reads. */
interface FailedRow {
  id: string;
  status: string;
  provider: string;
  engine: string;
  model_id: string;
  op: string;
  kind: string;
  preset_id: string | null;
  request_json: string;
  depends_on: string | null;
}

/**
 * A run failed on account `accountId`'s own GPU (generations.ts failRun), with what it ran into: claim its move to this
 * install's GPUs when the account said yes and the failure is one of its GPU's (src/lib/site-run.ts siteFallbackOf), for
 * a run made on its own (not a step of a longer run), never one made this way or on this install's GPUs. True when it was
 * claimed now (the caller sends it: site-fallback-run.ts). Synchronous, so the failed run reads "going to {Place}" from
 * the moment it reads failed.
 */
export function claimSiteFallback(id: string, accountId: string | undefined, trouble: RunTrouble | undefined, now = Date.now()): boolean {
  if (!accountId || !trouble || !siteFallbackOn(accountId)) return false;
  const r = db().prepare("SELECT id, status, provider, engine, model_id, op, kind, preset_id, request_json, depends_on FROM generations WHERE id = ?").get(id) as FailedRow | undefined;
  if (!r || r.status !== "failed") return false;
  let req: { account?: string; place?: string };
  try {
    req = JSON.parse(r.request_json) as { account?: string; place?: string };
  } catch {
    return false;
  }
  if (req.account !== accountId) return false;
  const g = {
    status: "failed" as const,
    provider: r.provider as never,
    engine: r.engine as never,
    modelId: r.model_id,
    op: r.op as never,
    kind: r.kind as never,
    presetId: r.preset_id,
    trouble,
    ...(req.place === "pool" && { place: "pool" as const }),
  };
  // (This install's rules are checked by the Run it is sent through: a run they don't take is left as it is.)
  if (!siteFallbackOfRun(g, true, undefined)) return false;
  // Made this way already: never again (a run there that failed is never one of its own GPU's, but nothing loops).
  if (movedFromOf(id)) return false;
  // A step of a longer run (it waits for another, or another waits for it) stays with its run.
  if (r.depends_on) return false;
  if (db().prepare("SELECT 1 FROM generations WHERE depends_on = @id OR (substr(depends_on, 1, 1) = '[' AND instr(depends_on, @quoted) > 0) LIMIT 1").get({ id, quoted: JSON.stringify(id) })) return false;
  return db().prepare("INSERT INTO site_fallback_runs (run_id, account_id, state, new_id, at) VALUES (?, ?, 'sending', NULL, ?) ON CONFLICT(run_id) DO NOTHING").run(id, accountId, now).changes > 0;
}


/** The move was made: the run made for it. */
export function noteMoved(id: string, newId: string, now = Date.now()): void {
  db().prepare("UPDATE site_fallback_runs SET state = 'moved', new_id = ?, at = ? WHERE run_id = ?").run(newId, now, id);
  touch(id, now);
}

/** The move wasn't taken (refused, held, or this install's GPUs off): the failed run stays as it was. */
export function noteRefused(id: string, now = Date.now()): void {
  db().prepare("UPDATE site_fallback_runs SET state = 'refused', at = ? WHERE run_id = ? AND state = 'sending'").run(now, id);
  touch(id, now);
}

/** The failed run's card changed (moved, or not): the lists read it again. */
function touch(id: string, now: number): void {
  db().prepare("UPDATE generations SET updated_at = ? WHERE id = ?").run(now, id);
}
