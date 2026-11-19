"use client";

import { Loader2, RotateCcw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MirrorReader } from "@/lib/live/mirror";
import { cameraProblemOf, createFaceReader, openCamera, type CameraProblem, type FaceReader } from "@/lib/live/mirror-camera";
import { cn } from "@/lib/utils";

/** How often the face is read (the renders are far slower; this only needs to catch a change quickly). */
const READ_EVERY_MS = 66;

const PROBLEMS: Record<CameraProblem, { title: string; text: string }> = {
  blocked: { title: "Let Mirror use your camera", text: "Click the camera icon in your browser's address bar, choose Allow, then press Try again." },
  none: { title: "Connect a camera", text: "Plug in a webcam, or open this page on a device with a front camera, then press Try again." },
  busy: { title: "Your camera is open in another app", text: "Close the call or app that is using it, then press Try again." },
  browser: { title: "Open Mirror in Chrome, Edge, Firefox or Safari", text: "This browser keeps the camera away from web pages. Any of these lets Mirror use it." },
  load: { title: "Mirror needs a moment online", text: "It gets ready over your connection the first time. Check you are online, then press Try again." },
};

type State = { s: "starting" } | { s: "live"; face: boolean } | { s: "problem"; why: CameraProblem };

const sentence = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

/**
 * Mirror's self-view: the person's own camera, mirrored, beside the character. The camera opens when this mounts (the
 * person just turned Mirror on) and closes when it unmounts. Each steady expression goes to `onPhrase`; nothing else
 * leaves the page.
 */
export function LiveMirror({ onPhrase, onStop }: { onPhrase: (phrase: string) => void; onStop: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State>({ s: "starting" });
  const [phrase, setPhrase] = useState("");
  const [attempt, setAttempt] = useState(0);
  const send = useRef(onPhrase);
  useEffect(() => {
    send.current = onPhrase;
  });

  useEffect(() => {
    let alive = true;
    let stream: MediaStream | null = null;
    let reader: FaceReader | null = null;
    let raf = 0;
    const el = video.current;
    void (async () => {
      const ready = createFaceReader();
      ready.catch(() => {});
      try {
        stream = await openCamera();
      } catch (e) {
        if (alive) setState({ s: "problem", why: cameraProblemOf(e) });
        void ready.then((r) => r.close(), () => {});
        return;
      }
      if (!alive || !el) return stream.getTracks().forEach((t) => t.stop());
      el.srcObject = stream;
      try {
        await el.play();
        reader = await ready;
      } catch (e) {
        // The camera goes off while the panel says how to go on.
        stream.getTracks().forEach((t) => t.stop());
        void ready.then((r) => r.close(), () => {});
        if (alive) setState({ s: "problem", why: e && typeof e === "object" && "name" in e && (e as { name: string }).name === "NotAllowedError" ? "blocked" : "load" });
        return;
      }
      if (!alive) return reader.close();
      const mirror = new MirrorReader();
      let lastRead = 0;
      let seen: boolean | null = null;
      let first = true;
      const loop = (now: number) => {
        if (!alive || !reader) return;
        raf = requestAnimationFrame(loop);
        if (now - lastRead < READ_EVERY_MS) return;
        lastRead = now;
        let read = null;
        try {
          read = reader.read(el, now);
        } catch {
          read = null;
        }
        const r = mirror.push(read, now);
        if (r.face !== seen) {
          seen = r.face;
          setState({ s: "live", face: r.face });
        }
        if (r.face && (r.changed || first)) {
          first = false;
          setPhrase(r.phrase);
          send.current(r.phrase);
        }
      };
      raf = requestAnimationFrame(loop);
    })();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      reader?.close();
      if (el) el.srcObject = null;
    };
  }, [attempt]);

  const problem = state.s === "problem" ? PROBLEMS[state.why] : null;
  return (
    <div className="flex shrink-0 items-stretch gap-2 max-sm:h-28 sm:w-56 sm:flex-col lg:w-64" data-live-mirror={state.s}>
      <div className="relative aspect-[3/4] shrink-0 overflow-hidden rounded-2xl bg-media max-sm:h-full sm:w-full">
        <video ref={video} muted playsInline className={cn("absolute inset-0 size-full -scale-x-100 object-cover", state.s !== "live" && "opacity-0")} aria-label="Your camera, mirrored" />
        {state.s === "starting" && (
          <span className="absolute inset-0 grid place-items-center text-white/80">
            <Loader2 className="size-5 animate-spin" />
          </span>
        )}
        {state.s === "live" && !state.face && <span className="absolute inset-x-1.5 bottom-1.5 rounded-lg bg-black/55 px-2 py-1 text-center text-[11px] text-white backdrop-blur">Face the camera</span>}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-none">
        {problem ? (
          <>
            <p className="text-[13px] leading-snug font-medium">{problem.title}</p>
            <p className="text-[12px] leading-snug text-muted-foreground max-sm:line-clamp-2">{problem.text}</p>
            <div className="mt-auto flex gap-1.5 sm:mt-1">
              <Button
                size="sm"
                onClick={() => {
                  setState({ s: "starting" });
                  setAttempt((n) => n + 1);
                }}
              >
                <RotateCcw className="size-3.5" />
                Try again
              </Button>
              <Button size="sm" variant="ghost" onClick={onStop}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="line-clamp-3 min-h-[3lh] text-[12.5px] leading-snug" aria-live="polite" data-live-mirror-phrase>
              {state.s === "starting" ? "Getting your camera ready…" : phrase ? sentence(phrase) : "Make a face: the picture follows."}
            </p>
            <Button size="sm" variant="secondary" onClick={onStop} className="mt-auto self-start sm:mt-0" data-live-mirror-stop>
              <Square className="size-3.5" />
              Stop
            </Button>
            <p className="text-[11px] leading-snug text-muted-foreground max-sm:hidden">Your camera stays on this device. Only a few words about your expression are sent.</p>
          </>
        )}
      </div>
    </div>
  );
}
