"use client";

import { useCreateGeneration, usePlaceName, useStatus } from "@/lib/api";
import type { Generation } from "@/lib/catalog/types";
import { runOnSiteAction, type TroubleAction } from "@/lib/diagnose";
import { toastError } from "@/lib/refusals";
import { askSiteFallback, useSetSiteFallback } from "@/lib/site-fallback";
import { asksSiteFallback, movedWords, siteRunOf, siteRunRequest } from "@/lib/site-run";
import type { TroubleHandlers } from "./trouble";

/**
 * "Run on {Place}" on a run that failed on the person's own GPU or key (hosted runs), the same on every card that shows a
 * failed run (a studio's feed, the Library, a tool page): the button first among the run's own, while this studio's GPUs
 * take it (src/lib/site-run.ts siteRunOf), and what a press does (the run made there once). After the first press on a
 * run its own GPU couldn't make, the account is asked once whether it should go there by itself next time.
 *
 * `actions(own)`: the run's buttons with the offer first. `more`: the handler for RunTroubleActions. `moved`: the words
 * for a run that went there by itself (null otherwise).
 */
export function useSiteRun(g: Generation): { actions: (own: TroubleAction[]) => TroubleAction[]; more: TroubleHandlers; moved: string | null } {
  const create = useCreateGeneration();
  const site = usePlaceName();
  const viewer = useStatus().data?.viewer;
  const setFallback = useSetSiteFallback();
  const run = siteRunOf(g, !!site, viewer?.pool);
  const offer = run && site ? runOnSiteAction(site.label) : null;
  return {
    actions: (own) => (offer ? [offer, ...own] : own),
    more: {
      onRunOnSite: () => {
        if (!run) return;
        create.mutate(siteRunRequest(g, run), {
          onSuccess: () => {
            if (site && asksSiteFallback(viewer, g)) askSiteFallback(site, (on) => setFallback.mutate(on));
          },
          onError: (e) => toastError(e),
        });
      },
    },
    moved: site ? movedWords(g, site.text) : null,
  };
}

/** The words of a failed run that went to this studio's GPUs by itself (or is on its way there), else null. */
export function useMovedWords(g: Pick<Generation, "movedTo" | "moving">): string | null {
  const site = usePlaceName();
  return site ? movedWords(g, site.text) : null;
}
