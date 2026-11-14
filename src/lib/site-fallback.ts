"use client";

import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { StatusInfo } from "./api";
import type { Place } from "./place-name";
import { siteFallbackQuestion, type SiteFallback } from "./site-run";

/**
 * The browser's side of "Run on {Place} automatically when your GPU can't" (hosted runs; src/server/site-fallback.ts):
 * asked once after the account's first "Run on {Place}" on a run its own GPU couldn't make, and switched in Settings →
 * Where your runs go. Kept on the server for every device; the page shows the answer at once.
 */

export const SITE_FALLBACK_PATH = "/api/account/site-fallback";

/** The answer as the page shows it at once, before the server answers. */
export function noteSiteFallback(qc: QueryClient, value: SiteFallback | undefined): void {
  qc.setQueryData<StatusInfo>(["status"], (s) => {
    if (!s?.viewer) return s;
    const { siteFallback: _was, ...viewer } = s.viewer;
    void _was;
    return { ...s, viewer: { ...viewer, ...(value && { siteFallback: value }) } };
  });
}

/** Keep the answer (PUT /api/account/site-fallback). Throws the server's words when it can't. */
export async function putSiteFallback(on: boolean): Promise<SiteFallback | undefined> {
  const res = await fetch(SITE_FALLBACK_PATH, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on }) });
  const b = (await res.json().catch(() => ({}))) as { siteFallback?: SiteFallback | null; error?: string };
  if (!res.ok) throw new Error(b.error ?? "That didn't save. Try once more.");
  return b.siteFallback ?? undefined;
}

/** Keep the answer: shown at once, kept on the server, and put back with the server's words when it can't be. */
export function useSetSiteFallback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) => putSiteFallback(on),
    onMutate: (on) => {
      const was = qc.getQueryData<StatusInfo>(["status"])?.viewer?.siteFallback;
      noteSiteFallback(qc, on ? "on" : "off");
      return { was };
    },
    onSuccess: (value) => noteSiteFallback(qc, value),
    onError: (e, _on, ctx) => {
      noteSiteFallback(qc, ctx?.was);
      toast((e as Error).message, { id: "site-fallback" });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["status"] }),
  });
}

/**
 * The one-time question, as a note that stays until it is answered: Yes, or Not now (kept as an answer too, so it is
 * asked once; Settings changes it later). A note put away without a press counts as Not now.
 */
export function askSiteFallback(place: Place, keep: (on: boolean) => void): void {
  let answered = false;
  const answer = (on: boolean) => {
    if (answered) return;
    answered = true;
    keep(on);
  };
  toast(siteFallbackQuestion(place.text), {
    id: "site-fallback-ask",
    duration: Infinity,
    action: { label: "Yes", onClick: () => answer(true) },
    cancel: { label: "Not now", onClick: () => answer(false) },
    onDismiss: () => answer(false),
  });
}
