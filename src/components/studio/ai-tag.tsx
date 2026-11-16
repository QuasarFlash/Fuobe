"use client";

import { Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useHydrated, useStatus } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Results carry an "AI-generated" tip where this studio runs visitors' work on its own GPUs (hosted runs on). With
 * hosted runs off, nothing new shows.
 */
export function useAiTag(): boolean {
  const hydrated = useHydrated();
  const hosted = !!useStatus().data?.viewer?.hosted;
  // Once hydrated: the page's first paint is the server's, which knows no status.
  return hydrated && hosted;
}

export const AI_TAG_WORDS = "AI-generated";

/**
 * The tip itself: a small info icon that says "AI-generated" on hover, on keyboard focus and on tap. The outermost
 * element carries `data-ai-tag` and holds the tooltip too (no portal), so one `[data-ai-tag]` rule covers all of it.
 * The wrapper lets clicks through; the icon's own click stays on it. `tone`: over a picture ("media") or on the page.
 */
export function AiTag({ className, tone = "media" }: { className?: string; tone?: "media" | "surface" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  // A tap elsewhere, or Escape, closes a tip opened by a tap.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span ref={ref} data-ai-tag className={cn("pointer-events-none relative inline-flex items-center", className)}>
      <button
        type="button"
        aria-label={AI_TAG_WORDS}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={cn(
          "peer pointer-events-auto grid size-5 shrink-0 cursor-help place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
          tone === "media" ? "bg-black/45 text-white/90 backdrop-blur hover:bg-black/65" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Info aria-hidden className="size-3.5" />
      </button>
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 left-full ml-1.5 -translate-y-1/2 rounded-md bg-foreground px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-background opacity-0 transition-opacity peer-hover:opacity-100 peer-focus-visible:opacity-100",
          open && "opacity-100",
        )}
      >
        {AI_TAG_WORDS}
      </span>
    </span>
  );
}
