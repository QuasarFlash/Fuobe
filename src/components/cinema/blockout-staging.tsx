"use client";

import { CircleQuestionMark, Film, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ACCEPT, LibraryGrid, kindOfFile, wrongKindMessage } from "@/components/studio/media-slot";
import { SCORE_EXAMPLE } from "@/lib/blockout-score";
import { clipTimeAt } from "@/lib/blockout-staging";
import { cn } from "@/lib/utils";

/**
 * The Blockout staging view's parts: a reference clip that plays in step with the playhead, the picker that adds one
 * (a file from this device, kept in the browser, or a clip from the library), and the score's help.
 */

export interface ReferenceClip {
  src: string;
  name: string;
  /** A file from this device: its object URL is freed when the clip goes. */
  local?: boolean;
}

/** How far the clip may drift from the playhead while both play before it is put back (seconds). */
const DRIFT = 0.2;

/** A reference clip at the playhead `t`, starting at `start` seconds of the blockout. */
export function ReferenceClipVideo({ clip, t, playing, start, muted, className, onLength }: { clip: ReferenceClip; t: number; playing: boolean; start: number; muted: boolean; className?: string; onLength?: (seconds: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [length, setLength] = useState(NaN);
  const at = clipTimeAt(t, start, length);

  useEffect(() => {
    const v = ref.current;
    if (!v || v.readyState < 1) return;
    if (playing && at.inside) {
      if (Math.abs(v.currentTime - at.time) > DRIFT) v.currentTime = at.time;
      if (v.paused) void v.play().catch(() => {});
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - at.time) > 1 / 60) v.currentTime = at.time;
    }
  }, [playing, at.inside, at.time, length]);

  return (
    <video
      ref={ref}
      src={clip.src}
      muted={muted}
      playsInline
      preload="auto"
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration;
        setLength(d);
        if (Number.isFinite(d)) onLength?.(d);
      }}
      className={cn("size-full object-contain transition-opacity", !at.inside && "opacity-40", className)}
      aria-label={`Reference clip: ${clip.name}`}
    />
  );
}

/** Add a reference clip: a file from this device (it stays in this browser) or a clip from the library. */
export function ClipPicker({ onPick, children }: { onPick: (clip: ReferenceClip) => void; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const fromDevice = (f: File) => {
    if (kindOfFile(f) !== "video") return toast.error(wrongKindMessage("video"));
    onPick({ src: URL.createObjectURL(f), name: f.name, local: true });
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-[min(92vw,340px)] p-2" align="start" collisionPadding={12}>
        <button type="button" onClick={() => input.current?.click()} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] font-medium hover:bg-accent">
          <Upload className="size-4" /> A clip from this device
        </button>
        <p className="px-2 pb-2 text-[11.5px] text-muted-foreground">It plays here only and is not uploaded.</p>
        <p className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">From your library</p>
        {open && <LibraryGrid kinds={["video"]} onPick={(v) => (onPick({ src: v.ref, name: v.name ?? "Library clip" }), setOpen(false))} />}
        <input ref={input} type="file" accept={ACCEPT.video} hidden onChange={(e) => (e.target.files?.[0] && fromDevice(e.target.files[0]), (e.target.value = ""))} />
      </PopoverContent>
    </Popover>
  );
}


/** What a score is and how it is written. */
export function ScoreHelp() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="grid size-7 shrink-0 place-items-center rounded-full opacity-75 hover:bg-current/10 hover:opacity-100" aria-label="What is a score?">
          <CircleQuestionMark className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(92vw,380px)] space-y-2 p-3 text-[12.5px]" align="end" collisionPadding={12}>
        <p className="font-medium">
          <Film className="mr-1 inline size-3.5" /> A score is the blockout&rsquo;s timeline as a text file
        </p>
        <p className="text-muted-foreground">It lists where the camera is and what it looks at over time, and where each actor walks. Export one to see it, change it in any text editor, then import it back.</p>
        <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
          <li>&ldquo;t&rdquo; is the time in seconds.</li>
          <li>Positions are metres: across, up, and towards the camera at the start.</li>
          <li>&ldquo;lens&rdquo; is in mm, &ldquo;shake&rdquo; from 0 to 1, &ldquo;turn&rdquo; in degrees.</li>
          <li>An actor with the name of a piece moves that piece; a new name adds a mannequin.</li>
        </ul>
        <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] leading-snug">{SCORE_EXAMPLE}</pre>
      </PopoverContent>
    </Popover>
  );
}
