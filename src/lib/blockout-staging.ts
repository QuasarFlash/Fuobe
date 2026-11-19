/**
 * The Blockout staging view's maths: the camera's trail and each moving piece's path over the blockout, the frustum of
 * the shot camera, a reference clip's time against the playhead, and the timeline's keys. No DOM, no three.js.
 */

import { BLOCKOUT, cameraAt, lensVFov, primAt, type BlockoutCameraKey, type BlockoutPrim, type BlockoutScene, type Vec3 } from "./blockout";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3, fallback: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : fallback;
};

/** The camera's path over `duration` (no handheld shake: the line the move follows), `samples` + 1 points. */
export function cameraTrail(keys: readonly BlockoutCameraKey[], duration: number, samples = 96): Vec3[] {
  const still = keys.map((k) => ({ ...k, shake: 0 }));
  const n = Math.max(1, Math.round(samples));
  return Array.from({ length: n + 1 }, (_, i) => cameraAt(still, (i / n) * Math.max(0, duration)).position);
}

export interface PiecePath {
  id: string;
  name: string;
  /** Where it is over the blockout, on the floor of its own position. */
  points: Vec3[];
  /** Where its keys are. */
  keys: Vec3[];
}

/** The path of each piece that travels (keys more than 5 cm apart): a door that only swings has none. */
export function piecePaths(s: Pick<BlockoutScene, "prims" | "duration">, samples = 96): PiecePath[] {
  const n = Math.max(1, Math.round(samples));
  return s.prims
    .filter((p): p is BlockoutPrim & { keys: NonNullable<BlockoutPrim["keys"]> } => (p.keys?.length ?? 0) > 1)
    .map((p) => ({ id: p.id, name: p.name, points: Array.from({ length: n + 1 }, (_, i) => primAt(p, (i / n) * Math.max(0, s.duration)).position), keys: p.keys.map((k) => [...k.position] as Vec3) }))
    .filter((p) => p.keys.some((k) => len(sub(k, p.keys[0])) > 0.05));
}

/**
 * The four far corners of the shot camera's frustum at `depth` metres along its view (top left, top right, bottom
 * right, bottom left), for a lens on a frame of `aspect` (width ÷ height). Up is +y, as the shot camera's.
 */
export function frustumCorners(position: Vec3, target: Vec3, lens: number, aspect: number, depth: number): [Vec3, Vec3, Vec3, Vec3] {
  const forward = unit(sub(target, position), [0, 0, -1]);
  // Looking straight up or down: the frame's right is +x.
  const right = unit(cross(forward, [0, 1, 0]), [1, 0, 0]);
  const up = cross(right, forward);
  const halfH = Math.tan((lensVFov(lens, aspect) * Math.PI) / 360) * depth;
  const halfW = halfH * aspect;
  const centre = add(position, scale(forward, depth));
  const at = (x: number, y: number) => add(add(centre, scale(right, x * halfW)), scale(up, y * halfH));
  return [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)];
}

/** How deep the staging view draws the frustum: out to what the camera looks at, within 1.5–8 m. */
export const frustumDepth = (position: Vec3, target: Vec3) => clamp(len(sub(target, position)), 1.5, 8);

/**
 * A reference clip's time at playhead `t` when it starts at `start` seconds of the blockout (earlier than 0: it starts
 * before the blockout). Outside the clip it holds its first or last frame, and `inside` is false.
 */
export function clipTimeAt(t: number, start: number, clipSeconds: number): { time: number; inside: boolean } {
  const at = t - start;
  const length = Number.isFinite(clipSeconds) && clipSeconds > 0 ? clipSeconds : Infinity;
  return { time: clamp(at, 0, Math.max(0, length - 0.001)), inside: at >= 0 && at <= length };
}

/** The furthest a reference clip may be moved against the blockout (seconds, either way). */
export const CLIP_SHIFT = BLOCKOUT.maxSeconds;

/**
 * The staging view's keyboard: the new playhead for a key, "toggle" for play and pause, or null when the key isn't
 * the timeline's. Space or K play and pause; comma and full stop step one frame; J and L one second; Home and End.
 */
export function timelineKey(key: string, t: number, duration: number, fps: number = BLOCKOUT.fps): number | "toggle" | null {
  const at = (n: number) => clamp(Math.round(n * fps) / fps, 0, duration);
  switch (key) {
    case " ":
    case "k":
    case "K":
      return "toggle";
    case ",":
      return at(t - 1 / fps);
    case ".":
      return at(t + 1 / fps);
    case "j":
    case "J":
      return at(t - 1);
    case "l":
    case "L":
      return at(t + 1);
    case "Home":
      return 0;
    case "End":
      return duration;
    default:
      return null;
  }
}
