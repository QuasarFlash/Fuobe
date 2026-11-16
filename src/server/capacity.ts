import "server-only";
import { MODELS } from "@/lib/catalog";
import { operationOutput, type GenerationRequest, type ModelDef } from "@/lib/catalog/types";
import { fitsLimit, laneClasses, largestFirst, secondsAt, stepDown, type CapacityView, type SizeClass, type SizeLimit } from "@/lib/capacity";
import { capacityLimits, poolLane } from "./computer/pool";
import { genjutsuSize, poolOnWorkers, requestMegapixels } from "./hosted";
import { getSetting } from "./settings";

/**
 * What the site can make now (src/lib/capacity.ts), for runs on this install's GPUs: by lane, then by model for the
 * composer (GET /api/capacity), kept for a few seconds. Only while those GPUs are the workers; otherwise nothing is
 * limited here, and with Settings → Workers' switch off (hostedOnlyWhatCanRun) every option is offered as before.
 */

const KEEP_MS = 5_000;

/** Is what is offered limited to what the site can make now: on the workers, with Settings → Workers' switch on? */
export const capacityOn = (): boolean => poolOnWorkers() && getSetting("hostedOnlyWhatCanRun") !== "off";
let kept: { at: number; lanes: Map<string, SizeClass[]>; view: CapacityView | null } | null = null;

/** Each lane's classes now (a lane no counted worker runs is left out). */
function lanesNow(now: number): Map<string, SizeClass[]> {
  if (kept && now - kept.at < KEEP_MS && now >= kept.at) return kept.lanes;
  const lanes = new Map<string, SizeClass[]>();
  for (const [lane, limits] of capacityLimits(now)) {
    const c = laneClasses(limits);
    if (c) lanes.set(lane, c);
  }
  kept = { at: now, lanes, view: null };
  return lanes;
}

/** Does a lane have a limit now (some size not made, or a longest clip)? */
const limited = (c: SizeClass[] | undefined): c is SizeClass[] => !!c && c.some((x) => x.seconds !== null);

/** The megapixels of a frame a route makes at this resolution and aspect, as the run's own check reads it. */
function framePixels(model: ModelDef, op: string, endpoint: string, resolution: string | undefined, aspect: string | undefined): number {
  const req = { modelId: model.id, op, feature: model.kind, params: { ...(resolution && { resolution }), ...(aspect && { aspectRatio: aspect }) } } as unknown as GenerationRequest;
  try {
    return requestMegapixels(req, operationOutput(op as never, model.kind), model.id, endpoint) ?? 0;
  } catch {
    return 0;
  }
}

/** One model's limits by operation and resolution (null: none of its routes is limited now). */
function modelLimits(model: ModelDef, lanes: Map<string, SizeClass[]>): Record<string, Record<string, SizeLimit>> | null {
  if (model.engine !== "open") return null;
  const out: Record<string, Record<string, SizeLimit>> = {};
  for (const r of model.routes) {
    if (r.provider !== "comfyui" || !r.endpoint || r.endpoint.includes("{") || out[r.op]) continue;
    const classes = lanes.get(poolLane(r.endpoint));
    if (!limited(classes)) continue;
    const still = operationOutput(r.op, model.kind) !== "video";
    const resolutions = model.options.resolutions?.length ? model.options.resolutions : [model.defaults?.resolution ?? ""];
    const aspects = model.options.aspectRatios?.length ? model.options.aspectRatios : [model.defaults?.aspectRatio ?? ""];
    const table: Record<string, SizeLimit> = {};
    for (const res of resolutions) {
      const byAspect: Record<string, number> = {};
      for (const ar of aspects) {
        const s = secondsAt(classes, framePixels(model, r.op, r.endpoint, res || undefined, ar || undefined));
        // A picture: only a size that isn't made at all.
        if (s !== null && (!still || s === 0)) byAspect[ar] = still ? 0 : s;
      }
      const values = Object.values(byAspect);
      if (!values.length) continue;
      table[res] = values.length === aspects.length && values.every((v) => v === values[0]) ? values[0] : byAspect;
    }
    if (Object.keys(table).length) out[r.op] = table;
  }
  return Object.keys(out).length ? out : null;
}

/** What the site can make now, by model (only the models limited now), for the composer. Empty off the workers. */
export function capacityView(now = Date.now()): CapacityView {
  if (!capacityOn()) return { m: {} };
  const lanes = lanesNow(now);
  if (kept?.view) return kept.view;
  const m: CapacityView["m"] = {};
  if ([...lanes.values()].some(limited)) {
    for (const model of MODELS) {
      const t = modelLimits(model, lanes);
      if (t) m[model.id] = t;
    }
  }
  const view = { m };
  if (kept) kept.view = view;
  return view;
}

/** The longest clip a lane makes now at a frame size (null: no limit, or no worker runs the lane now; 0: not made). */
export function laneLimitNow(lane: string, megapixels: number, now = Date.now()): number | null {
  if (!capacityOn()) return null;
  return secondsAt(lanesNow(now).get(lane), megapixels);
}

/** Forget the classes kept (the tests change workers between checks). */
export function forgetCapacity(): void {
  kept = null;
}

/**
 * A new run on this install's GPUs against what the site can make now: "fits" as asked, a request stepped down to the
 * nearest length and size made now (a shorter length first, then a smaller size), or "none" when nothing it could be
 * stepped down to is made. A run whose own size its request states (a Genjutsu part), or a model whose lane has no
 * limit now, fits.
 */
export function fitRequest(req: GenerationRequest, route: { endpoint?: string; op: string }, model: ModelDef, now = Date.now()): { kind: "fits" } | { kind: "stepped"; req: GenerationRequest } | { kind: "none" } {
  const endpoint = route.endpoint;
  if (!endpoint || endpoint.includes("{") || !capacityOn() || genjutsuSize(req)) return { kind: "fits" };
  const classes = lanesNow(now).get(poolLane(endpoint));
  if (!limited(classes)) return { kind: "fits" };
  const kind = operationOutput(route.op as never, model.kind);
  if (kind !== "video" && kind !== "image") return { kind: "fits" };
  const still = kind === "image";
  const limit = (resolution: string | undefined) => {
    const r = { ...req, params: { ...req.params, ...(resolution && { resolution }) } };
    try {
      return secondsAt(classes, requestMegapixels(r, kind, model.id, endpoint) ?? 0);
    } catch {
      return null;
    }
  };
  const duration = req.params?.duration ?? (still ? undefined : model.defaults?.duration);
  const resolution = req.params?.resolution ?? model.defaults?.resolution;
  if (fitsLimit(limit(resolution), still ? 0 : (duration ?? 0))) return { kind: "fits" };
  const lengths = !still && model.options.durations?.length ? model.options.durations : null;
  const resolutions = model.options.resolutions?.length ? largestFirst(model.options.resolutions) : null;
  const next = stepDown({ lengths, resolutions, limit, still }, { duration, resolution });
  if (!next) return { kind: "none" };
  return { kind: "stepped", req: { ...req, params: { ...req.params, ...next } } };
}
