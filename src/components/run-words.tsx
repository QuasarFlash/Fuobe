"use client";

import { useEffect, useState } from "react";
import type { Generation } from "@/lib/catalog/types";
import { creatingLabel, creatingParts, PHRASE_MS, PHRASE_SETS, phraseAt, phraseSetOf } from "@/lib/job-phrases";

/**
 * A run's words on its card or row. A person's run on this studio's GPUs that is being made shows a phrase about its own
 * job in place of "Creating" (src/lib/job-phrases.ts), the next one every PHRASE_MS with a gentle fade (none with
 * reduced motion), and the percent after it. A screen reader hears the same stable words throughout ("Creating, 40%"),
 * never each phrase. Any other words show as they are.
 */
export function RunWords({ g, words }: { g: Pick<Generation, "id" | "op" | "kind" | "place" | "status">; words: string }) {
  const parts = g.place === "pool" && g.status === "running" ? creatingParts(words) : null;
  const [tick, setTick] = useState(0);
  const on = !!parts;
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setTick((n) => n + 1), PHRASE_MS);
    return () => clearInterval(t);
  }, [on]);
  if (!parts) return <>{words}</>;
  const set = phraseSetOf({ op: g.op, kind: g.kind });
  // Counted from the run's own first phrase (the same on the server's render and the browser's).
  const { phrase, index } = phraseAt(set, g.id, (tick % PHRASE_SETS[set].length) * PHRASE_MS);
  const after = parts.percent ? parts.rest.replace(/^ · \d{1,3}%/, "") : parts.rest;
  return (
    <>
      <span className="sr-only">{`${creatingLabel(parts.percent)}${after}`}</span>
      <span aria-hidden="true" aria-live="off" data-phrase={set}>
        <span key={index} className="animate-in duration-700 fade-in-0 motion-reduce:animate-none">
          {phrase}
        </span>
        {parts.rest}
      </span>
    </>
  );
}
