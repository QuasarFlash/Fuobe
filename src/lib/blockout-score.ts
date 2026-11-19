/**
 * A Blockout score: the timeline of a blockout as a plain text file (JSON), so camera moves and actor paths can be
 * written by hand or by another tool, played against a reference clip, and brought back as an ordinary blockout.
 *
 * Format, version 1. Times are seconds from the start. Positions are metres [x, y, z], y up, the floor at y = 0.
 * The lens is the focal length in mm on a full-frame body.
 *
 *   {
 *     "score": 1,                          optional; a higher number is refused
 *     "name": "Corridor and door",         optional
 *     "duration": 8,                       optional; default: the last key's time (2 to 60 s)
 *     "aspect": "16:9",                    optional; width:height
 *     "camera": [                          up to 32 keys
 *       { "t": 0, "position": [0.35, 1.55, 1.8], "target": [0, 1.3, -6], "lens": 28, "shake": 0.45 }
 *     ],                                   lens optional (default: the key before, else 28); shake optional, 0 to 1
 *     "actors": [                          up to 24 actors, each with 1 to 32 keys
 *       { "name": "Woman", "kind": "mannequin", "keys": [{ "t": 0, "position": [0, 0, -1], "turn": 180 }] }
 *     ],                                   id, kind and turn (degrees about the vertical) optional
 *     "markers": [{ "t": 4.5, "label": "The door opens" }]
 *   }
 *
 * At least one camera key or one actor. Numbers out of range are brought into range; the file size and the key counts
 * are capped. Importing: the camera keys, markers, length, shape and name replace the scene's when the score has them;
 * an actor whose id (or else name) matches a piece moves that piece; any other actor is added as a new piece.
 */

import { BLOCKOUT, PRIMS, newId, newPrim, normalizeScene, type BlockoutPrim, type BlockoutScene, type PrimKind, type Vec3 } from "./blockout";

export const SCORE = {
  version: 1,
  /** The largest score file (characters). */
  maxChars: 256 * 1024,
  maxCameraKeys: BLOCKOUT.maxCameraKeys,
  maxActors: 24,
  maxActorKeys: BLOCKOUT.maxCameraKeys,
  maxMarkers: BLOCKOUT.maxMarkers,
  /** Positions stay within this many metres of the origin. */
  reach: 500,
} as const;

export interface ScoreCameraKey {
  t: number;
  position: Vec3;
  target: Vec3;
  lens: number;
  shake?: number;
}

export interface ScoreActorKey {
  t: number;
  position: Vec3;
  turn?: number;
}

export interface ScoreActor {
  id?: string;
  name: string;
  kind?: PrimKind;
  keys: ScoreActorKey[];
}

export interface ScoreMarker {
  t: number;
  label: string;
}

export interface BlockoutScore {
  score: 1;
  name?: string;
  duration: number;
  aspect?: string;
  /** Absent: the scene keeps its own. */
  camera?: ScoreCameraKey[];
  actors?: ScoreActor[];
  markers?: ScoreMarker[];
}

export type ScoreResult = { ok: true; score: BlockoutScore; notes: string[] } | { ok: false; error: string };

const r3 = (n: number) => Math.round(n * 1000) / 1000 + 0;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ASPECT = /^\d+(\.\d+)?:\d+(\.\d+)?$/;

class ScoreError extends Error {}

/** Read a score file's text: the score, or a message that says in plain words what to fix. */
export function parseScore(text: string): ScoreResult {
  if (typeof text !== "string") return { ok: false, error: "This file couldn't be read as text." };
  if (text.length > SCORE.maxChars) return { ok: false, error: `This score is too big: a score file holds up to ${SCORE.maxChars / 1024} KB.` };
  const body = text.replace(/^﻿/, "").trim();
  if (!body) return { ok: false, error: "This file is empty." };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    const line = lineOf(body, String((e as Error)?.message ?? ""));
    return { ok: false, error: `This isn't a score Blockout can read${line ? `: check near line ${line} for a missing comma, quote or bracket` : ""}.` };
  }
  return validateScore(raw);
}

/** The line a JSON.parse message points at ("line 3 column 5" or "position 45"). */
function lineOf(text: string, message: string): number | null {
  const line = /line (\d+)/i.exec(message);
  if (line) return Number(line[1]);
  const pos = /position (\d+)/i.exec(message);
  if (!pos) return null;
  return text.slice(0, Number(pos[1])).split("\n").length;
}

/** A score as read from a file, checked and brought into range. */
export function validateScore(raw: unknown): ScoreResult {
  try {
    return read(raw);
  } catch (e) {
    if (e instanceof ScoreError) return { ok: false, error: e.message };
    throw e;
  }
}

function read(raw: unknown): ScoreResult {
  if (!isObject(raw)) throw new ScoreError("A score starts with { and lists the camera keys and actors inside it.");
  if (raw.score !== undefined) {
    if (typeof raw.score === "number" && raw.score > SCORE.version) throw new ScoreError("This score was written for a newer version of Blockout.");
    if (raw.score !== SCORE.version) throw new ScoreError(`"score" should be ${SCORE.version}.`);
  }
  let moved = 0;
  const num = (v: unknown, where: string, what: string, lo: number, hi: number): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new ScoreError(`${where} needs ${what} as a number.`);
    const n = Math.max(lo, Math.min(hi, v));
    if (n !== v) moved++;
    return r3(n);
  };
  const vec = (v: unknown, where: string, field: string, example: string): Vec3 => {
    if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new ScoreError(`${where}: "${field}" needs three numbers, like ${example}.`);
    return v.map((n) => num(n, where, field, -SCORE.reach, SCORE.reach)) as Vec3;
  };
  const list = (v: unknown, field: string, max: number, what: string): unknown[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) throw new ScoreError(`"${field}" should be a list in [ ].`);
    if (v.length > max) throw new ScoreError(`A score holds up to ${plural(max, what)}; this one has ${v.length}.`);
    return v;
  };
  const time = (k: Record<string, unknown>, where: string) => {
    if (typeof k.t !== "number" || !Number.isFinite(k.t)) throw new ScoreError(`${where} needs a time "t" in seconds.`);
    return num(k.t, where, "its time", 0, BLOCKOUT.maxSeconds);
  };
  const entry = (v: unknown, where: string): Record<string, unknown> => {
    if (!isObject(v)) throw new ScoreError(`${where} should be written inside { }.`);
    return v;
  };

  let lastLens: number = BLOCKOUT.lens.default;
  const camera = list(raw.camera, "camera", SCORE.maxCameraKeys, "camera key")
    ?.map((v, i) => {
      const where = `Camera key ${i + 1}`;
      const k = entry(v, where);
      const t = time(k, where);
      const lens = k.lens === undefined ? lastLens : num(k.lens, where, "the lens in mm", BLOCKOUT.lens.min, BLOCKOUT.lens.max);
      lastLens = lens;
      const shake = k.shake === undefined ? undefined : num(k.shake, where, "shake (0 to 1)", 0, 1);
      return { t, position: vec(k.position, where, "position", "[0, 1.6, 4]"), target: vec(k.target, where, "target", "[0, 1.2, 0]"), lens, ...(shake ? { shake } : {}) };
    })
    .sort((a, b) => a.t - b.t);

  const kinds = Object.keys(PRIMS) as PrimKind[];
  const actors = list(raw.actors, "actors", SCORE.maxActors, "actor")?.map((v, i) => {
    const where = `Actor ${i + 1}`;
    const a = entry(v, where);
    if (a.name !== undefined && typeof a.name !== "string") throw new ScoreError(`${where}: "name" should be words in quotes.`);
    if (a.id !== undefined && typeof a.id !== "string") throw new ScoreError(`${where}: "id" should be words in quotes.`);
    if (a.kind !== undefined && !kinds.includes(a.kind as PrimKind)) throw new ScoreError(`${where}: "kind" can be ${kinds.join(", ")}.`);
    const name = (typeof a.name === "string" ? a.name.trim().slice(0, 60) : "") || `Actor ${i + 1}`;
    const keysRaw = list(a.keys, `${where}'s keys`, SCORE.maxActorKeys, "keys per actor");
    if (!keysRaw?.length) throw new ScoreError(`${where} (${name}) needs at least one key in "keys".`);
    const keys = keysRaw
      .map((kv, j) => {
        const kw = `${where} (${name}), key ${j + 1}`;
        const k = entry(kv, kw);
        const turn = k.turn === undefined ? undefined : num(k.turn, kw, "a turn in degrees", -3600, 3600);
        return { t: time(k, kw), position: vec(k.position, kw, "position", "[0, 0, -1]"), ...(turn !== undefined ? { turn } : {}) };
      })
      .sort((x, y) => x.t - y.t);
    return {
      ...(typeof a.id === "string" && a.id.trim() ? { id: a.id.trim().slice(0, 40) } : {}),
      name,
      ...(a.kind !== undefined ? { kind: a.kind as PrimKind } : {}),
      keys,
    };
  });

  const markers = list(raw.markers, "markers", SCORE.maxMarkers, "marker")
    ?.map((v, i) => {
      const where = `Marker ${i + 1}`;
      const m = entry(v, where);
      if (m.label !== undefined && typeof m.label !== "string") throw new ScoreError(`${where}: "label" should be words in quotes.`);
      return { t: time(m, where), label: (typeof m.label === "string" ? m.label.trim().slice(0, 80) : "") || `Beat ${i + 1}` };
    })
    .sort((a, b) => a.t - b.t);

  if (!camera?.length && !actors?.length) throw new ScoreError("This score has no camera keys and no actors: add a \"camera\" or an \"actors\" list.");
  if (raw.name !== undefined && typeof raw.name !== "string") throw new ScoreError('"name" should be words in quotes.');
  if (raw.aspect !== undefined && (typeof raw.aspect !== "string" || !ASPECT.test(raw.aspect.trim()))) throw new ScoreError('"aspect" should look like "16:9".');

  const times = [...(camera ?? []).map((k) => k.t), ...(actors ?? []).flatMap((a) => a.keys.map((k) => k.t)), ...(markers ?? []).map((m) => m.t)];
  const latest = Math.max(0, ...times);
  const duration = raw.duration === undefined ? r3(Math.max(BLOCKOUT.minSeconds, Math.min(BLOCKOUT.maxSeconds, latest))) : num(raw.duration, "The score", '"duration" in seconds', BLOCKOUT.minSeconds, BLOCKOUT.maxSeconds);
  const late = times.filter((t) => t > duration + 1e-6).length;

  const notes: string[] = [];
  if (moved) notes.push(`${plural(moved, "number")} ${moved === 1 ? "was" : "were"} outside what Blockout allows and ${moved === 1 ? "was" : "were"} brought into range.`);
  if (late) notes.push(`${plural(late, "key")} after the end (${duration} s) ${late === 1 ? "lands" : "land"} on the last frame.`);
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 80) : "";
  return {
    ok: true,
    notes,
    score: {
      score: 1,
      ...(name ? { name } : {}),
      duration,
      ...(typeof raw.aspect === "string" ? { aspect: raw.aspect.trim() } : {}),
      ...(camera ? { camera } : {}),
      ...(actors ? { actors } : {}),
      ...(markers ? { markers } : {}),
    },
  };
}

/** A scene's timeline as a score: its camera keys, every piece that moves, and its markers. */
export function scoreFromScene(s: BlockoutScene): BlockoutScore {
  return {
    score: 1,
    name: s.name,
    duration: s.duration,
    aspect: s.aspect,
    camera: s.camera.map((k) => ({ t: r3(k.t), position: k.position.map(r3) as Vec3, target: k.target.map(r3) as Vec3, lens: r3(k.lens), ...(k.shake ? { shake: r3(k.shake) } : {}) })),
    actors: s.prims
      .filter((p) => p.keys?.length)
      .map((p) => ({ id: p.id, name: p.name, kind: p.kind, keys: p.keys!.map((k) => ({ t: r3(k.t), position: k.position.map(r3) as Vec3, turn: r3(k.rotation) })) })),
    markers: s.markers.map((m) => ({ t: r3(m.t), label: m.label })),
  };
}

/** One value on one line: `{ "t": 0, "position": [0, 1.6, 4] }`. */
function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
  if (isObject(v)) {
    const parts = Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`);
    return parts.length ? `{ ${parts.join(", ")} }` : "{}";
  }
  return JSON.stringify(v);
}

/** A score as the text of a file: one key per line, easy to read and edit by hand. */
export function scoreText(score: BlockoutScore): string {
  const block = (items: string[], pad: string) => (items.length ? `[\n${items.map((x) => `${pad}  ${x}`).join(",\n")}\n${pad}]` : "[]");
  const actor = (a: ScoreActor) => {
    const head = inline({ id: a.id, name: a.name, kind: a.kind }).slice(2, -2);
    return `{ ${head}, "keys": ${block(a.keys.map(inline), "    ")} }`;
  };
  const lines: string[] = [`"score": ${score.score}`];
  if (score.name !== undefined) lines.push(`"name": ${JSON.stringify(score.name)}`);
  lines.push(`"duration": ${score.duration}`);
  if (score.aspect !== undefined) lines.push(`"aspect": ${JSON.stringify(score.aspect)}`);
  if (score.camera) lines.push(`"camera": ${block(score.camera.map(inline), "  ")}`);
  if (score.actors) lines.push(`"actors": ${block(score.actors.map(actor), "  ")}`);
  if (score.markers) lines.push(`"markers": ${block(score.markers.map(inline), "  ")}`);
  return `{\n${lines.map((l) => `  ${l}`).join(",\n")}\n}\n`;
}

export interface ScoreApplied {
  scene: BlockoutScene;
  /** Pieces already in the scene that now follow the score. */
  moved: number;
  added: number;
  /** Actors left out: the scene was full. */
  dropped: number;
}

/** The scene with a score's timeline in it: still an ordinary blockout (normalized), so everything after it works as before. */
export function applyScore(scene: BlockoutScene, score: BlockoutScore): ScoreApplied {
  const prims: BlockoutPrim[] = scene.prims.map((p) => ({ ...p }));
  const taken = new Set<string>();
  const ids = new Set(prims.map((p) => p.id));
  let moved = 0;
  let added = 0;
  let dropped = 0;
  for (const a of score.actors ?? []) {
    const wanted = a.name.trim().toLowerCase();
    const match = (a.id ? prims.find((p) => p.id === a.id && !taken.has(p.id)) : undefined) ?? prims.find((p) => !taken.has(p.id) && p.name.trim().toLowerCase() === wanted);
    const keysFrom = (startTurn: number) => {
      let turn = startTurn;
      return a.keys.map((k) => {
        turn = k.turn ?? turn;
        return { t: k.t, position: [...k.position] as Vec3, rotation: turn };
      });
    };
    if (match) {
      const keys = keysFrom(match.keys?.[0]?.rotation ?? match.rotation);
      Object.assign(match, { keys, position: keys[0].position, rotation: keys[0].rotation });
      taken.add(match.id);
      moved++;
      continue;
    }
    if (prims.length >= BLOCKOUT.maxPrims) {
      dropped++;
      continue;
    }
    const kind: PrimKind = a.kind === "mesh" ? "box" : (a.kind ?? "mannequin");
    const keys = keysFrom(0);
    const id = a.id && !ids.has(a.id) ? a.id : newId(kind[0]);
    ids.add(id);
    taken.add(id);
    prims.push({ ...newPrim(kind, keys[0].position, a.name), id, rotation: keys[0].rotation, keys });
    added++;
  }
  const next = normalizeScene({
    ...scene,
    name: score.name ?? scene.name,
    duration: score.duration,
    aspect: score.aspect ?? scene.aspect,
    prims,
    camera: score.camera?.length ? score.camera.map((k) => ({ t: k.t, position: k.position, target: k.target, lens: k.lens, shake: k.shake ?? 0 })) : scene.camera,
    // A marker keeps its id (and so the words written for its beat) when the scene has one of the same name.
    markers: score.markers
      ? score.markers.map((m) => ({ id: scene.markers.find((x) => x.label.trim().toLowerCase() === m.label.toLowerCase())?.id ?? newId("m"), t: m.t, label: m.label }))
      : scene.markers,
  });
  return { scene: next, moved, added, dropped };
}

/** "corridor-and-door.score.json": a file name for a scene's score. */
export function scoreFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "blockout"}.score.json`;
}
