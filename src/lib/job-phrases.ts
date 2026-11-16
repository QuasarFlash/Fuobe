/**
 * The words a person's run on this install's GPUs shows while it is made, in place of "Creating": a few short phrases
 * about its own job, chosen by its operation and what it makes (never by its prompt), one after another every
 * PHRASE_MS. A job that isn't certain gets the neutral set; a phrase about motion, light or sound only appears on a job
 * that makes or changes them.
 *
 * Pure: the run cards and the tests share it.
 */
import type { MediaKind, Operation } from "./catalog/types";
import { POOL_WORDS } from "./relay";

export const PHRASE_SETS = {
  picture: ["Composing", "Shaping the light", "Adding fine detail"],
  edit: ["Making your changes", "Matching the light", "Blending it in"],
  upscale: ["Sharpening the details", "Restoring fine detail", "Cleaning it up"],
  cutout: ["Tracing the edges", "Separating the subject", "Cleaning the edges"],
  video: ["Setting up the shot", "Adding motion", "Getting the light right"],
  videoChange: ["Following every frame", "Keeping it consistent", "Matching the motion"],
  videoTools: ["Processing every frame", "Keeping it smooth"],
  sound: ["Tuning the sound", "Finding the rhythm", "Mixing it down"],
  model3d: ["Building the shape", "Shaping the surfaces"],
  neutral: ["Working on it", "Taking care of the details", "Making it just right"],
} as const satisfies Record<string, readonly string[]>;

export type PhraseSet = keyof typeof PHRASE_SETS;

/** How long each phrase shows. */
export const PHRASE_MS = 7_000;

/** By output kind: an operation that works on pictures or on clips alike. */
const byKind = (image: PhraseSet, video: PhraseSet) => (kind: MediaKind | null | undefined): PhraseSet => (kind === "image" ? image : kind === "video" ? video : "neutral");

/** 3D words only on a run that made a 3D model (a scene made for a picture model, a body drawn over a photo: neutral). */
const as3d = (kind: MediaKind | null | undefined): PhraseSet => (kind === "model3d" ? "model3d" : "neutral");

/** Every operation's set (a function: it follows what the run makes). */
const OP_SETS: Record<Operation, PhraseSet | ((kind: MediaKind | null | undefined) => PhraseSet)> = {
  // A picture from words.
  t2i: "picture",
  // Picture edits.
  edit: "edit",
  inpaint: "edit",
  outpaint: "edit",
  "face-swap": byKind("edit", "videoChange"),
  relight: "edit",
  "watermark-remove": "edit",
  "picture-frame": "edit",
  "color-match": byKind("edit", "videoTools"),
  overlay: "edit",
  // Upscale and restore.
  "upscale-image": "upscale",
  "upscale-video": "upscale",
  "restore-video": "upscale",
  // Cut-outs, masks and mattes.
  "bg-remove": "cutout",
  "bg-remove-video": "cutout",
  // A video from words or pictures.
  t2v: "video",
  i2v: "video",
  flf2v: "video",
  ref2v: "video",
  keyframes: "video",
  extend: "video",
  avatar: "video",
  "insert-moment": "video",
  "camera-path": "video",
  "world-turn": "video",
  // A video changed.
  v2v: "videoChange",
  "motion-transfer": "videoChange",
  "video-swap": "videoChange",
  "video-insert": "videoChange",
  "remove-object": "videoChange",
  "group-swap": "videoChange",
  "scene-edit": "videoChange",
  "face-fix-video": "videoChange",
  "relight-video": "videoChange",
  reframe: "videoChange",
  finalize: "videoChange",
  "picture-video": "videoChange",
  composite: "videoChange",
  lipsync: "videoChange",
  // Video tools.
  interpolate: "videoTools",
  "sdr-to-hdr": "videoTools",
  "export-video": "videoTools",
  trim: "videoTools",
  concat: "videoTools",
  "images-to-video": "videoTools",
  "still-motion": "videoTools",
  "depth-video": "videoTools",
  "tone-video": "videoTools",
  captions: "videoTools",
  mux: "videoTools",
  "body-capture-video": "videoTools",
  // Sound and music.
  tts: "sound",
  sfx: "sound",
  music: "sound",
  v2a: "sound",
  dialogue: "sound",
  "voice-change": "sound",
  "voice-design": "sound",
  "speech-edit": "sound",
  "separate-audio": "sound",
  "enhance-voice": "sound",
  level: "sound",
  timeline: "sound",
  mix: "sound",
  "audio-loop": "sound",
  "audio-join": "sound",
  "song-extend": "sound",
  "song-remix": "sound",
  "song-stems": "sound",
  // 3D.
  "image-to-3d": "model3d",
  "scene-3d": as3d,
  splat: "model3d",
  "text-to-3d": "model3d",
  "rig-3d": "model3d",
  "refine-3d": "model3d",
  "retexture-3d": "model3d",
  "body-capture": as3d,
  // Anything else: the neutral set.
  grade: "neutral",
  motion: "neutral",
  dub: "neutral",
  frame: "neutral",
  "extract-frames": "neutral",
  layers: "neutral",
  "text-layers": "neutral",
  transcribe: "neutral",
  translate: "neutral",
  write: "neutral",
  vectorize: "neutral",
  ocr: "neutral",
  "face-mosaic": "neutral",
  "watermark-scan": "neutral",
  "describe-video": "neutral",
};

/** The phrase set of a run's job, by its operation and what it makes (none known: the neutral set). */
export function phraseSetOf(job: { op?: string | null; kind?: MediaKind | string | null }): PhraseSet {
  const set = job.op && Object.hasOwn(OP_SETS, job.op) ? OP_SETS[job.op as Operation] : undefined;
  if (!set) return "neutral";
  return typeof set === "function" ? set(job.kind as MediaKind | null | undefined) : set;
}

/** A small number from a run's id, so tiles side by side start on different phrases. */
function idSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** The phrase a run shows at `now`: from its own starting phrase, the next one every PHRASE_MS. */
export function phraseAt(set: PhraseSet, id: string, now: number): { phrase: string; index: number } {
  const list = PHRASE_SETS[set];
  const index = (idSeed(id) + Math.floor(Math.max(0, now) / PHRASE_MS)) % list.length;
  return { phrase: list[index], index };
}

/** Every phrase a running job may show in place of "Creating". */
export const JOB_PHRASES: ReadonlySet<string> = new Set(Object.values(PHRASE_SETS).flat());

/**
 * A run's words split where "Creating" (or one of its phrases) starts them: what follows ("· 40%", "· about 3 min
 * left"), and the percent. Null: words that don't start with it ("In line", "Almost done", a failure).
 */
export function creatingParts(words: string | null | undefined): { rest: string; percent: string | null } | null {
  if (!words) return null;
  const head = [POOL_WORDS.working, ...JOB_PHRASES].find((w) => words === w || words.startsWith(`${w} · `));
  if (!head) return null;
  const rest = words.slice(head.length);
  return { rest, percent: /^ · (\d{1,3}%)/.exec(rest)?.[1] ?? null };
}

/** The stable words a screen reader hears for a running job ("Creating, 40%"), whichever phrase shows. */
export const creatingLabel = (percent: string | null): string => (percent ? `${POOL_WORDS.working}, ${percent}` : POOL_WORDS.working);
