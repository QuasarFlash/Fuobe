/**
 * Live edit's Mirror mode (pure, tested in tests/live-mirror.test.ts). The camera stays in the browser: a face tracker
 * there gives 52 expression scores (0-1, ARKit names) and the head's pose matrix, and this file turns them into a short
 * plain phrase ("smiling widely with the mouth open, eyebrows raised"). Only that phrase is sent, inside a fixed edit
 * prompt on the same base picture, so frames never drift.
 *
 * Jitter never resends: scores are smoothed, each feature is quantised into a few levels with hysteresis, and a new
 * phrase must hold for a moment before it counts. The pacer keeps one render in flight and sends only a changed phrase.
 */

import { MAX_LIVE_TEXT } from "./text";

export type Scores = Readonly<Record<string, number>>;

/** The head's pose in degrees, as the person sees it in the mirrored self-view. */
export interface Pose {
  /** Positive: the face turns toward the right of the frame. */
  yaw: number;
  /** Positive: the chin goes up. */
  pitch: number;
  /** Positive: the top of the head tilts toward the right of the frame. */
  roll: number;
}

/** The self-view is a mirror: the person's left is the frame's left. */
const MIRRORED = true;

const DEG = 180 / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The pose from the face's 4x4 transformation matrix (column-major, camera space: x right in the unmirrored image, y up,
 * z toward the camera). Null for a matrix that isn't one.
 */
export function poseOf(m: ArrayLike<number> | null | undefined): Pose | null {
  if (!m || m.length < 16) return null;
  for (let i = 0; i < 11; i++) if (!Number.isFinite(m[i])) return null;
  const unit = (x: number, y: number, z: number) => {
    const n = Math.hypot(x, y, z);
    return n > 1e-9 ? [x / n, y / n, z / n] : null;
  };
  const side = unit(m[0], m[1], m[2]);
  const fwd = unit(m[8], m[9], m[10]);
  if (!side || !fwd) return null;
  const s = MIRRORED ? -1 : 1;
  return {
    yaw: s * Math.atan2(fwd[0], fwd[2]) * DEG + 0,
    pitch: Math.asin(clamp(fwd[1], -1, 1)) * DEG + 0,
    roll: -s * Math.atan2(side[1], side[0]) * DEG + 0,
  };
}

/** The expression features read from the scores (each 0-1, or degrees for the pose). */
export interface Features {
  smile: number;
  lopsided: number;
  jaw: number;
  frown: number;
  pucker: number;
  funnel: number;
  puff: number;
  press: number;
  sneer: number;
  browUp: number;
  browDown: number;
  browOne: number;
  blink: number;
  wink: number;
  wide: number;
  squint: number;
  lookUp: number;
  lookDown: number;
  yaw: number;
  pitch: number;
  roll: number;
}

const avg = (s: Scores, a: string, b: string) => ((s[a] ?? 0) + (s[b] ?? 0)) / 2;
const diff = (s: Scores, a: string, b: string) => Math.abs((s[a] ?? 0) - (s[b] ?? 0));

export function featuresOf(s: Scores, pose: Pose | null): Features {
  return {
    smile: avg(s, "mouthSmileLeft", "mouthSmileRight"),
    lopsided: diff(s, "mouthSmileLeft", "mouthSmileRight"),
    jaw: s.jawOpen ?? 0,
    frown: avg(s, "mouthFrownLeft", "mouthFrownRight"),
    pucker: s.mouthPucker ?? 0,
    funnel: s.mouthFunnel ?? 0,
    puff: s.cheekPuff ?? 0,
    press: avg(s, "mouthPressLeft", "mouthPressRight"),
    sneer: avg(s, "noseSneerLeft", "noseSneerRight"),
    browUp: Math.max(s.browInnerUp ?? 0, avg(s, "browOuterUpLeft", "browOuterUpRight")),
    browDown: avg(s, "browDownLeft", "browDownRight"),
    browOne: diff(s, "browOuterUpLeft", "browOuterUpRight"),
    blink: avg(s, "eyeBlinkLeft", "eyeBlinkRight"),
    wink: diff(s, "eyeBlinkLeft", "eyeBlinkRight"),
    wide: avg(s, "eyeWideLeft", "eyeWideRight"),
    squint: avg(s, "eyeSquintLeft", "eyeSquintRight"),
    lookUp: avg(s, "eyeLookUpLeft", "eyeLookUpRight"),
    lookDown: avg(s, "eyeLookDownLeft", "eyeLookDownRight"),
    yaw: pose?.yaw ?? 0,
    pitch: pose?.pitch ?? 0,
    roll: pose?.roll ?? 0,
  };
}

/** Each feature's level cuts (ascending), and how far past a cut a value must go to change level. */
const CUTS: Record<keyof Features, readonly number[]> = {
  smile: [0.25, 0.55],
  lopsided: [0.3],
  jaw: [0.2, 0.5],
  frown: [0.3],
  pucker: [0.5],
  funnel: [0.4],
  puff: [0.4],
  press: [0.5],
  sneer: [0.4],
  browUp: [0.3, 0.6],
  browDown: [0.4],
  browOne: [0.35],
  blink: [0.35, 0.65],
  wink: [0.45],
  wide: [0.35],
  squint: [0.55],
  lookUp: [0.45],
  lookDown: [0.45],
  yaw: [10, 24],
  pitch: [10, 22],
  roll: [9, 20],
};
const SIGNED = new Set<keyof Features>(["yaw", "pitch", "roll"]);
const SCORE_GAP = 0.06;
const ANGLE_GAP = 3;

export type Levels = Record<keyof Features, number>;
export const FEATURE_NAMES = Object.keys(CUTS) as (keyof Features)[];
export const NEUTRAL_LEVELS: Levels = Object.fromEntries(FEATURE_NAMES.map((k) => [k, 0])) as Levels;

/** The level of `v` (0 = under every cut), sticking to `prev` until `v` is `gap` past a cut. */
export function levelOf(v: number, prev: number, cuts: readonly number[], gap: number): number {
  let l = clamp(Math.round(prev), 0, cuts.length);
  while (l < cuts.length && v >= cuts[l] + gap) l++;
  while (l > 0 && v < cuts[l - 1] - gap) l--;
  return l;
}

/** The same for a signed value: the sign is the side, the size the level (a change of side starts from level 0). */
export function signedLevelOf(v: number, prev: number, cuts: readonly number[], gap: number): number {
  const sign = v < 0 ? -1 : 1;
  const from = Math.sign(prev) === sign ? Math.abs(prev) : 0;
  return sign * levelOf(Math.abs(v), from, cuts, gap) || 0;
}

export function levelsOf(f: Features, prev: Levels = NEUTRAL_LEVELS): Levels {
  const out = {} as Levels;
  for (const k of FEATURE_NAMES) {
    out[k] = SIGNED.has(k) ? signedLevelOf(f[k], prev[k], CUTS[k], ANGLE_GAP) : levelOf(f[k], prev[k], CUTS[k], SCORE_GAP);
  }
  return out;
}

/** The phrase for a set of levels: mouth, brows, eyes, then the head. Always positive, never a negation. */
export function phraseOf(l: Levels): string {
  const face: string[] = [];
  const mouth = (() => {
    if (l.pucker) return "lips puckered as if blowing a kiss";
    if (l.funnel) return "lips rounded into an O";
    if (l.puff) return "cheeks puffed out";
    if (l.smile) {
      if (l.smile >= 2) return l.jaw >= 2 ? "laughing with the mouth wide open" : l.jaw ? "smiling widely with the mouth open" : "smiling widely";
      if (l.lopsided) return "with a lopsided smirk";
      return l.jaw ? "smiling softly with the lips parted" : "smiling softly";
    }
    if (l.frown) return l.jaw ? "the corners of the mouth turned down, lips parted" : "the corners of the mouth turned down";
    if (l.jaw >= 2) return "with the mouth wide open";
    if (l.jaw) return "with the lips slightly parted";
    if (l.press) return "lips pressed together";
    return null;
  })();
  if (mouth) face.push(mouth);
  if (l.sneer) face.push("nose scrunched");
  if (l.browOne) face.push("one eyebrow raised");
  else if (l.browUp >= 2) face.push("eyebrows raised high");
  else if (l.browUp) face.push("eyebrows slightly raised");
  else if (l.browDown) face.push("brows furrowed");
  const closed = l.blink >= 2;
  if (l.wink && !closed) face.push("winking one eye");
  else if (closed) face.push("eyes closed");
  else if (l.blink) face.push("eyes half closed");
  else if (l.wide) face.push("eyes wide open");
  else if (l.squint) face.push("eyes narrowed");
  if (!closed && !l.wink) {
    if (l.lookUp) face.push("looking up");
    else if (l.lookDown) face.push("looking down");
  }

  const head: string[] = [];
  const side = (v: number) => (v > 0 ? "right" : "left");
  if (l.yaw) head.push(`head turned ${Math.abs(l.yaw) >= 2 ? "" : "slightly "}toward the ${side(l.yaw)} of the frame`);
  if (l.pitch >= 2) head.push("chin raised high");
  else if (l.pitch === 1) head.push("chin slightly raised");
  else if (l.pitch <= -2) head.push("head bowed");
  else if (l.pitch === -1) head.push("chin slightly lowered");
  if (l.roll) head.push(`head tilted ${Math.abs(l.roll) >= 2 ? "" : "slightly "}toward the ${side(l.roll)} of the frame`);

  if (!face.length) face.push("with a calm, relaxed expression");
  if (!head.length) head.push("facing the camera");
  return [...face, ...head].join(", ");
}

/** The edit prompt for a phrase: the same picture, only the expression and pose changed. */
export function mirrorPrompt(phrase: string): string {
  return `The same character, now ${phrase}. Keep the face, hairstyle, outfit, framing, lighting and background exactly as they are.`.slice(0, MAX_LIVE_TEXT);
}

export interface MirrorReading {
  /** The newest phrase that has held long enough (what to render). */
  phrase: string;
  /** A face was seen in this frame. */
  face: boolean;
  /** The phrase changed with this frame. */
  changed: boolean;
}

/**
 * Turns tracker frames into a steady phrase: scores smoothed (exponential, `alpha` per frame), quantised with
 * hysteresis, and a new phrase taken only once it has held `holdMs`.
 */
export class MirrorReader {
  private smooth: Record<string, number> | null = null;
  private levels: Levels = NEUTRAL_LEVELS;
  private candidate: { phrase: string; since: number } | null = null;
  private stable: string;
  private readonly alpha: number;
  private readonly holdMs: number;

  constructor(o: { alpha?: number; holdMs?: number } = {}) {
    this.alpha = o.alpha ?? 0.5;
    this.holdMs = o.holdMs ?? 150;
    this.stable = phraseOf(NEUTRAL_LEVELS);
  }

  get phrase(): string {
    return this.stable;
  }

  /** One frame: the scores and pose matrix of the face seen, or null when none was. `now` in ms. */
  push(face: { scores: Scores; matrix?: ArrayLike<number> | null } | null, now: number): MirrorReading {
    if (!face) {
      this.candidate = null;
      return { phrase: this.stable, face: false, changed: false };
    }
    const pose = poseOf(face.matrix);
    const raw: Record<string, number> = { ...featuresOf(face.scores, pose) };
    const a = this.alpha;
    const prev = this.smooth;
    this.smooth = prev ? Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, a * v + (1 - a) * (prev[k] ?? v)])) : raw;
    this.levels = levelsOf(this.smooth as unknown as Features, this.levels);
    const p = phraseOf(this.levels);
    if (p === this.stable) {
      this.candidate = null;
      return { phrase: p, face: true, changed: false };
    }
    if (!this.candidate || this.candidate.phrase !== p) this.candidate = { phrase: p, since: now };
    if (now - this.candidate.since >= this.holdMs) {
      this.stable = p;
      this.candidate = null;
      return { phrase: p, face: true, changed: true };
    }
    return { phrase: this.stable, face: true, changed: false };
  }

  reset(): void {
    this.smooth = null;
    this.levels = NEUTRAL_LEVELS;
    this.candidate = null;
    this.stable = phraseOf(NEUTRAL_LEVELS);
  }
}

export type MirrorDone = "ok" | "dropped" | "error";

/**
 * One render in flight, and only a phrase that differs from the last one sent. A dropped render (stopped, replaced,
 * paused) lets its phrase go again; a failed one waits for the next change.
 */
export class MirrorPacer {
  private wanted: string | null = null;
  private sent: string | null = null;
  private busy = false;

  want(phrase: string): void {
    this.wanted = phrase;
  }

  /** The phrase to render now, or null (one is in flight, or nothing changed). Marks it in flight. */
  take(): string | null {
    if (this.busy || this.wanted === null || this.wanted === this.sent) return null;
    this.busy = true;
    this.sent = this.wanted;
    return this.sent;
  }

  done(outcome: MirrorDone): void {
    this.busy = false;
    if (outcome === "dropped") this.sent = null;
  }

  get inFlight(): boolean {
    return this.busy;
  }

  /** A new base, or Mirror started again: the newest phrase goes again (one in flight stays counted until done). */
  resend(): void {
    this.sent = null;
  }

  reset(): void {
    this.wanted = null;
    this.sent = null;
  }
}
