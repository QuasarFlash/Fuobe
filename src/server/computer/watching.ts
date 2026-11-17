import "server-only";
import { db } from "../db";

/**
 * Who is watching their runs now: an account whose open page asked about its runs lately. A page of the studio asks
 * while one of its runs waits or works (the runs list behind the tab's job count, the feed, a run's tile, the Library),
 * and stops asking while its tab is hidden, so a page that asked within WATCH_FRESH_MS is one the person has open. The
 * line on this install's GPUs reads it (pool.ts smartLine): a person watching goes first in each round. Nothing new is
 * asked of the browser: the proxy notes the reads the page already makes (noteWatching), at most once every
 * WATCH_NOTE_MS for each account. Kept in the database (relay_watching), so every app process sees the same.
 */

/** A person counts as watching while their page asked about their runs this recently. */
export const WATCH_FRESH_MS = 60_000;
/** The most often one account's watching is written (a page asks every few seconds). */
export const WATCH_NOTE_MS = 15_000;

declare global {
  var __fuobeWatchNoted: Map<string, number> | undefined;
}

/** The reads of a page that follows its runs: the runs list, one run, and a run's live picture. */
const FOLLOWS = /^\/api\/generations(?:\/(?!(?:facets|trash|stream|zip|bulk|local)$)[^/]+(?:\/preview)?)?$/;

/** Is this request a page following its runs (a GET of the runs list, one run, or a run's live picture)? */
export const followsRuns = (method: string, pathname: string): boolean => (method === "GET" || method === "HEAD") && FOLLOWS.test(pathname);

/** An account's page asked about its runs now. Best-effort: it never fails the request. */
export function noteWatching(account: string, now = Date.now()): void {
  const noted = (globalThis.__fuobeWatchNoted ??= new Map());
  const last = noted.get(account);
  if (last !== undefined && now - last < WATCH_NOTE_MS && now >= last) return;
  try {
    db().prepare("INSERT INTO relay_watching (account, seen_at) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET seen_at = MAX(seen_at, excluded.seen_at)").run(account, now);
    noted.set(account, now);
    if (noted.size > 5000) noted.delete(noted.keys().next().value!);
  } catch {}
}

/** The accounts watching their runs now (their page asked within WATCH_FRESH_MS). */
export function watchingNow(now = Date.now()): Set<string> {
  try {
    return new Set((db().prepare("SELECT account FROM relay_watching WHERE seen_at > ?").all(now - WATCH_FRESH_MS) as { account: string }[]).map((r) => r.account));
  } catch {
    return new Set();
  }
}
