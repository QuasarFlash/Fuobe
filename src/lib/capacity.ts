/**
 * What the site can make now, in clip lengths and frame sizes: the workers that are on (online, paused in neither place)
 * and those back within CAPACITY_GRACE_MS, each lane's longest clip at each frame-size class. The composer offers only
 * the lengths and sizes some such worker makes, and a new run is stepped down to them.
 *
 * Pure: the server (src/server/capacity.ts), the composer and the tests share it.
 */

/** A worker that stops being on keeps counting for this long (a short drop doesn't change what is offered). */
export const CAPACITY_GRACE_MS = 5 * 60_000;

/** One worker's limits in a lane: its lane's own clip limits and its PC's ceiling. */
export interface LaneLimit {
  maxSeconds?: number;
  bigFrom?: number;
  bigMaxSeconds?: number;
  ceilingSeconds?: number;
  ceilingMegapixels?: number;
}

/**
 * A frame-size class: frames up to `upTo` megapixels (null: any larger) are made up to `seconds` long (null: no limit;
 * 0: not made at this size). Classes go from the smallest frames up.
 */
export type SizeClass = { upTo: number | null; seconds: number | null };

const EPS = 1e-9;

/** The longest clip one worker makes in a lane at this frame size (undefined: no limit; 0: it doesn't make this size). */
export function workerMostSeconds(l: LaneLimit, megapixels: number): number | undefined {
  if (l.ceilingMegapixels && megapixels > l.ceilingMegapixels + EPS) return 0;
  const big = l.bigFrom && l.bigMaxSeconds && megapixels > l.bigFrom + EPS ? l.bigMaxSeconds : undefined;
  const limits = [l.maxSeconds, big, l.ceilingSeconds].filter((x): x is number => !!x && x > 0);
  return limits.length ? Math.min(...limits) : undefined;
}

/**
 * A lane's classes from the limits of the workers counted in it (none: null, so the lane keeps today's behaviour). The
 * longest clip of each class is the best any of them makes there.
 */
export function laneClasses(limits: readonly LaneLimit[]): SizeClass[] | null {
  if (!limits.length) return null;
  const marks = [...new Set(limits.flatMap((l) => [l.bigFrom && l.bigMaxSeconds ? l.bigFrom : 0, l.ceilingMegapixels ?? 0]).filter((x) => x > 0))].sort((a, b) => a - b);
  const at = (mp: number): number | null => {
    let best: number | null = 0;
    for (const l of limits) {
      const s = workerMostSeconds(l, mp);
      if (s === undefined) return null;
      if (best !== null && s > best) best = s;
    }
    return best;
  };
  const out: SizeClass[] = [];
  for (const [i, upTo] of [...marks, null].entries()) {
    // Upper bounds are inclusive (a frame of exactly `bigFrom` megapixels is still small); past the last mark, just over it.
    const seconds = at(i < marks.length ? marks[i] : (marks.at(-1) ?? 0) + 1e-6);
    const last = out.at(-1);
    if (last && last.seconds === seconds) last.upTo = upTo;
    else out.push({ upTo, seconds });
  }
  return out;
}

/** The longest clip of a frame size in a lane's classes (null: no limit; 0: not made). */
export function secondsAt(classes: readonly SizeClass[] | null | undefined, megapixels: number): number | null {
  if (!classes?.length) return null;
  for (const c of classes) if (c.upTo === null || megapixels <= c.upTo + EPS) return c.seconds;
  return classes[classes.length - 1].seconds;
}

/** Does a job of this size fit (`seconds`: 0 for a picture)? */
export const fitsLimit = (limit: number | null, seconds: number): boolean => limit === null || (limit > 0 && seconds <= limit + EPS);

// ---------------------------------------------------------------------------
// The view the composer reads (GET /api/capacity)

/** A resolution's limit: one for every aspect, or by aspect ratio. A resolution left out has no limit. */
export type SizeLimit = number | Record<string, number>;

/** By model id, then operation, then resolution ("" for a model with none): only the models whose lane is limited now. */
export interface CapacityView {
  m: Record<string, Record<string, Record<string, SizeLimit>>>;
}

/**
 * The longest clip of a model at a resolution and aspect (null: no limit; 0: not made). `op` unknown: the most any of its
 * operations makes. An aspect it doesn't name (the frame follows a picture): the most of its aspects.
 */
export function limitAt(view: CapacityView | null | undefined, modelId: string | undefined, op: string | undefined, resolution: string | undefined, aspect: string | undefined): number | null {
  const byOp = modelId ? view?.m[modelId] : undefined;
  if (!byOp) return null;
  // An operation left out runs in a lane with no limit now.
  const tables = op ? (byOp[op] ? [byOp[op]] : []) : Object.values(byOp);
  if (!tables.length) return null;
  let most = 0;
  for (const t of tables) {
    const v = t[resolution ?? ""];
    if (v === undefined) return null;
    const n = typeof v === "number" ? v : aspect && v[aspect] !== undefined ? v[aspect] : Math.max(0, ...Object.values(v));
    most = Math.max(most, n);
  }
  return most;
}

/** The lengths offered under a limit (seconds; a length past it isn't offered). */
export const lengthsUnder = (lengths: readonly number[], limit: number | null): number[] => (limit === null ? [...lengths] : lengths.filter((s) => fitsLimit(limit, s)));

/** A resolution's size, for "smaller": "768p" → 768, "2K" → 2000, "1MP" → 1000 (unknown: its place in the list). */
function resolutionRank(r: string, i: number): number {
  const p = /^(\d+(?:\.\d+)?)p$/i.exec(r);
  if (p) return Number(p[1]);
  const k = /^(\d+(?:\.\d+)?)K$/i.exec(r);
  if (k) return Number(k[1]) * 1000;
  const mp = /^(\d+(?:\.\d+)?)MP$/i.exec(r);
  if (mp) return Math.sqrt(Number(mp[1])) * 1000;
  return i;
}

/** Resolutions from the largest down. */
export const largestFirst = (resolutions: readonly string[]): string[] =>
  resolutions
    .map((r, i) => ({ r, n: resolutionRank(r, i) }))
    .sort((a, b) => b.n - a.n)
    .map((x) => x.r);

export interface OfferFacts {
  /** The model's lengths to pick from (null: none to pick; the run's length is `duration`). */
  lengths: readonly number[] | null;
  /** The model's resolutions to pick from (null: none to pick). */
  resolutions: readonly string[] | null;
  /** The longest clip at a resolution (null: no limit; 0: not made). */
  limit: (resolution: string | undefined) => number | null;
  /** A picture: only whether its size is made counts. */
  still?: boolean;
}

/** Is a resolution offered: made at some length offered (a picture: made at all)? */
export function resolutionOffered(f: OfferFacts, resolution: string | undefined, duration: number | undefined): boolean {
  const limit = f.limit(resolution);
  if (limit === null) return true;
  if (limit <= 0) return false;
  if (f.still) return true;
  if (f.lengths?.length) return lengthsUnder(f.lengths, limit).length > 0;
  return fitsLimit(limit, duration ?? 0);
}

/**
 * A choice stepped down to what is offered: a shorter length first, then a smaller size (the length then the longest
 * offered there up to the one picked). Null: the choice is offered as it is, or nothing smaller is.
 */
export function stepDown(f: OfferFacts, now: { duration?: number; resolution?: string }): { duration?: number; resolution?: string } | null {
  const fits = (res: string | undefined, d: number | undefined) => {
    const limit = f.limit(res);
    return limit === null || (limit > 0 && (f.still || fitsLimit(limit, d ?? 0)));
  };
  if (fits(now.resolution, now.duration)) return null;
  const sizes = f.resolutions?.length ? largestFirst(f.resolutions) : [now.resolution];
  const from = now.resolution !== undefined && sizes.includes(now.resolution) ? sizes.indexOf(now.resolution) : 0;
  for (const res of sizes.slice(from)) {
    const limit = f.limit(res);
    if (limit !== null && limit <= 0) continue;
    if (f.still) return res === now.resolution ? null : { resolution: res };
    const lengths = f.lengths?.length ? [...lengthsUnder(f.lengths, limit)].sort((a, b) => b - a) : null;
    if (lengths) {
      if (!lengths.length) continue;
      const d = lengths.find((s) => s <= (now.duration ?? Infinity) + EPS) ?? lengths[lengths.length - 1];
      return { ...(d !== now.duration && { duration: d }), ...(res !== now.resolution && { resolution: res }) };
    }
    if (fits(res, now.duration)) return res === now.resolution ? null : { resolution: res };
  }
  return null;
}
