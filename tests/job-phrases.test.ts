import { describe, expect, it } from "vitest";
import { MODELS } from "@/lib/catalog";
import { OPERATION_OUTPUT, operationOutput, type MediaKind, type Operation } from "@/lib/catalog/types";
import { creatingLabel, creatingParts, JOB_PHRASES, PHRASE_MS, PHRASE_SETS, phraseAt, phraseSetOf, type PhraseSet } from "@/lib/job-phrases";
import { isPoolRunWords } from "@/lib/run-progress";
import { POOL_WORDS } from "@/lib/relay";

/** Phrases about motion or frames in sequence, about light, and about sound. */
const MOTION = new Set(["Adding motion", "Matching the motion", "Following every frame", "Processing every frame", "Keeping it smooth"]);
const LIGHT = new Set(["Shaping the light", "Matching the light", "Getting the light right"]);
const SOUND = new Set(["Tuning the sound", "Finding the rhythm", "Mixing it down"]);
/** The operations that make or change sound. */
const SOUND_OPS = new Set<string>(["tts", "sfx", "music", "v2a", "dialogue", "voice-change", "voice-design", "speech-edit", "separate-audio", "enhance-voice", "level", "timeline", "mix", "audio-loop", "audio-join", "song-extend", "song-remix", "song-stems"]);

/** What a job of this operation and output may be told: the rules every phrase set must keep. */
function check(op: string, kind: MediaKind): string[] {
  const set = phraseSetOf({ op, kind });
  const phrases: readonly string[] = PHRASE_SETS[set];
  const problems: string[] = [];
  const say = (why: string) => problems.push(`${op} (${kind}) → ${set}: ${why}`);
  if (kind !== "video" && phrases.some((p) => MOTION.has(p))) say("a motion phrase on a job that makes no clip");
  if (kind !== "image" && kind !== "video" && phrases.some((p) => LIGHT.has(p))) say("a light phrase on a job that makes no picture");
  if (!SOUND_OPS.has(op) && phrases.some((p) => SOUND.has(p))) say("a sound phrase on a silent job");
  if (set === "model3d" && kind !== "model3d") say("3D words on a job that makes no 3D model");
  if (set === "cutout" && op !== "bg-remove" && op !== "bg-remove-video") say("cut-out words on a job that cuts nothing out");
  return problems;
}

describe("phrases that follow the job", () => {
  it("each set is the words given, plain and with no emoji", () => {
    expect(PHRASE_SETS.picture).toEqual(["Composing", "Shaping the light", "Adding fine detail"]);
    expect(PHRASE_SETS.edit).toEqual(["Making your changes", "Matching the light", "Blending it in"]);
    expect(PHRASE_SETS.upscale).toEqual(["Sharpening the details", "Restoring fine detail", "Cleaning it up"]);
    expect(PHRASE_SETS.cutout).toEqual(["Tracing the edges", "Separating the subject", "Cleaning the edges"]);
    expect(PHRASE_SETS.video).toEqual(["Setting up the shot", "Adding motion", "Getting the light right"]);
    expect(PHRASE_SETS.videoChange).toEqual(["Following every frame", "Keeping it consistent", "Matching the motion"]);
    expect(PHRASE_SETS.videoTools).toEqual(["Processing every frame", "Keeping it smooth"]);
    expect(PHRASE_SETS.sound).toEqual(["Tuning the sound", "Finding the rhythm", "Mixing it down"]);
    expect(PHRASE_SETS.model3d).toEqual(["Building the shape", "Shaping the surfaces"]);
    expect(PHRASE_SETS.neutral).toEqual(["Working on it", "Taking care of the details", "Making it just right"]);
    for (const p of JOB_PHRASES) expect(p).toMatch(/^[A-Z][a-z ]+$/);
  });

  it("every catalog route keeps the rules: no motion on stills, no sound on silent jobs, no light without pictures", () => {
    const problems: string[] = [];
    for (const m of MODELS) for (const r of m.routes ?? []) problems.push(...check(r.op, operationOutput(r.op, m.kind)));
    expect(problems).toEqual([]);
  });

  it("every operation keeps the rules for what it makes", () => {
    const problems: string[] = [];
    for (const op of Object.keys(OPERATION_OUTPUT) as Operation[]) {
      for (const kind of ["image", "video", "audio", "text", "model3d"] as MediaKind[]) {
        if (operationOutput(op, kind) !== kind && OPERATION_OUTPUT[op] !== kind) continue;
        problems.push(...check(op, kind));
      }
    }
    expect(problems).toEqual([]);
  });

  it("the sets by job", () => {
    const cases: [string | null, MediaKind | null, PhraseSet][] = [
      ["t2i", "image", "picture"],
      ["edit", "image", "edit"],
      ["inpaint", "image", "edit"],
      ["outpaint", "image", "edit"],
      ["face-swap", "image", "edit"],
      ["upscale-image", "image", "upscale"],
      ["upscale-video", "video", "upscale"],
      ["restore-video", "video", "upscale"],
      ["bg-remove", "image", "cutout"],
      ["bg-remove-video", "video", "cutout"],
      ["t2v", "video", "video"],
      ["i2v", "video", "video"],
      ["video-swap", "video", "videoChange"],
      ["group-swap", "video", "videoChange"],
      ["scene-edit", "video", "videoChange"],
      ["face-fix-video", "video", "videoChange"],
      ["motion-transfer", "video", "videoChange"],
      ["interpolate", "video", "videoTools"],
      ["export-video", "video", "videoTools"],
      ["sdr-to-hdr", "video", "videoTools"],
      ["trim", "video", "videoTools"],
      ["music", "audio", "sound"],
      ["tts", "audio", "sound"],
      ["image-to-3d", "model3d", "model3d"],
      ["transcribe", "text", "neutral"],
      ["no-such-op", "video", "neutral"],
      [null, "video", "neutral"],
    ];
    for (const [op, kind, set] of cases) expect(phraseSetOf({ op, kind }), `${op}`).toBe(set);
  });

  it("starts on a phrase picked from the run, and moves on every 7 seconds", () => {
    expect(PHRASE_MS).toBe(7_000);
    const a = phraseAt("video", "run-a", 0);
    const next = phraseAt("video", "run-a", PHRASE_MS);
    expect(next.index).toBe((a.index + 1) % PHRASE_SETS.video.length);
    expect(phraseAt("video", "run-a", PHRASE_MS - 1).index).toBe(a.index);
    const starts = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => phraseAt("neutral", id, 0).index));
    expect(starts.size).toBeGreaterThan(1);
  });

  it("splits a run's words where Creating starts them, and gives screen readers stable words", () => {
    expect(creatingParts("Creating · 40%")).toEqual({ rest: " · 40%", percent: "40%" });
    expect(creatingParts("Creating · 40% · about 3 min left")).toEqual({ rest: " · 40% · about 3 min left", percent: "40%" });
    expect(creatingParts("Creating · about 2 min left")).toEqual({ rest: " · about 2 min left", percent: null });
    expect(creatingParts("Creating")).toEqual({ rest: "", percent: null });
    expect(creatingParts("Adding motion · 40%")).toEqual({ rest: " · 40%", percent: "40%" });
    expect(creatingParts(POOL_WORDS.inLine)).toBeNull();
    expect(creatingParts(POOL_WORDS.gettingReady)).toBeNull();
    expect(creatingParts(POOL_WORDS.finishing)).toBeNull();
    expect(creatingLabel("40%")).toBe("Creating, 40%");
    expect(creatingLabel(null)).toBe("Creating");
  });

  it("every phrase passes for a running job's words, with its percent and time left or without", () => {
    for (const p of JOB_PHRASES) {
      expect(isPoolRunWords(p)).toBe(true);
      expect(isPoolRunWords(`${p} · 40%`)).toBe(true);
      expect(isPoolRunWords(`${p} · 40% · about 3 min left`)).toBe(true);
    }
    expect(isPoolRunWords("Rolling camera · 40%")).toBe(false);
  });
});
