import { describe, expect, it } from "vitest";
import { laneClasses, largestFirst, lengthsUnder, limitAt, resolutionOffered, secondsAt, stepDown, workerMostSeconds, type CapacityView, type OfferFacts } from "@/lib/capacity";

describe("a lane's classes from the workers counted now", () => {
  const small = { bigFrom: 0.5, bigMaxSeconds: 5.2 };
  it("no worker: no classes (the lane keeps today's behaviour)", () => {
    expect(laneClasses([])).toBeNull();
  });
  it("one worker with no limit: none at any size", () => {
    expect(laneClasses([{}])).toEqual([{ upTo: null, seconds: null }]);
  });
  it("a small worker alone: any length up to its frame mark, 5.2 s past it", () => {
    const c = laneClasses([small])!;
    expect(c).toEqual([
      { upTo: 0.5, seconds: null },
      { upTo: null, seconds: 5.2 },
    ]);
    expect(secondsAt(c, 0.4)).toBeNull();
    // Exactly at the mark is still small, as the line reads it.
    expect(secondsAt(c, 0.5)).toBeNull();
    expect(secondsAt(c, 1.03)).toBe(5.2);
  });
  it("the best of the workers in each class", () => {
    const c = laneClasses([small, { maxSeconds: 8 }])!;
    expect(secondsAt(c, 0.3)).toBeNull();
    expect(secondsAt(c, 1)).toBe(8);
    expect(secondsAt(laneClasses([small, {}]), 1)).toBeNull();
  });
  it("a PC's ceiling: no frame past its megapixels, no clip past its seconds", () => {
    expect(workerMostSeconds({ ceilingMegapixels: 0.3 }, 0.6)).toBe(0);
    expect(workerMostSeconds({ ceilingSeconds: 6, maxSeconds: 10 }, 0.2)).toBe(6);
    const c = laneClasses([{ ceilingMegapixels: 0.3 }])!;
    expect(secondsAt(c, 0.25)).toBeNull();
    expect(secondsAt(c, 0.6)).toBe(0);
  });
});

describe("what the composer offers and where a choice steps down to", () => {
  const view: CapacityView = { m: { h3: { t2v: { "768p": 5.2 }, i2v: { "768p": { "16:9": 5.2, "1:1": 10 } } }, wan: { t2v: { "720p": 0 } } } };
  it("the limit by model, operation, resolution and aspect", () => {
    expect(limitAt(view, "h3", "t2v", "768p", "16:9")).toBe(5.2);
    expect(limitAt(view, "h3", "i2v", "768p", "1:1")).toBe(10);
    // No aspect to pick (the frame follows a picture): the most of its aspects.
    expect(limitAt(view, "h3", "i2v", "768p", undefined)).toBe(10);
    // An operation, resolution or model left out: no limit.
    expect(limitAt(view, "h3", "ref2v", "768p", "16:9")).toBeNull();
    expect(limitAt(view, "wan", "t2v", "480p", "16:9")).toBeNull();
    expect(limitAt(view, "other", "t2v", "720p", "16:9")).toBeNull();
    expect(limitAt(undefined, "h3", "t2v", "768p", "16:9")).toBeNull();
  });
  it("lengths past the limit aren't offered", () => {
    expect(lengthsUnder([3, 5, 10, 15], 5.2)).toEqual([3, 5]);
    expect(lengthsUnder([3, 5], null)).toEqual([3, 5]);
    expect(lengthsUnder([3, 5], 0)).toEqual([]);
  });
  const wan: OfferFacts = { lengths: [5, 8, 10], resolutions: ["480p", "720p", "1080p"], limit: (r) => (r === "1080p" ? 0 : r === "720p" ? 5 : null) };
  it("a size is offered when some offered length is made at it", () => {
    expect(resolutionOffered(wan, "480p", 10)).toBe(true);
    expect(resolutionOffered(wan, "720p", 10)).toBe(true);
    expect(resolutionOffered(wan, "1080p", 5)).toBe(false);
    expect(resolutionOffered({ ...wan, still: true }, "720p", undefined)).toBe(true);
  });
  it("steps down a shorter length first, then a smaller size", () => {
    expect(stepDown(wan, { duration: 10, resolution: "720p" })).toEqual({ duration: 5 });
    expect(stepDown(wan, { duration: 5, resolution: "720p" })).toBeNull();
    expect(stepDown(wan, { duration: 10, resolution: "1080p" })).toEqual({ duration: 5, resolution: "720p" });
    expect(stepDown(wan, { duration: 10, resolution: "480p" })).toBeNull();
    // Nothing smaller is made: no step (the server refuses such a run).
    expect(stepDown({ ...wan, limit: () => 0 }, { duration: 5, resolution: "480p" })).toBeNull();
    // A picture: a smaller size only.
    expect(stepDown({ lengths: null, resolutions: ["1K", "2K", "4K"], still: true, limit: (r) => (r === "1K" ? null : 0) }, { resolution: "4K" })).toEqual({ resolution: "1K" });
  });
  it("orders sizes largest first", () => {
    expect(largestFirst(["480p", "1080p", "720p"])).toEqual(["1080p", "720p", "480p"]);
    expect(largestFirst(["1K", "0.5K", "2K"])).toEqual(["2K", "1K", "0.5K"]);
  });
});
