import { describe, expect, it } from "vitest";
import { heldRun, startedWords } from "@/lib/run-progress";
import { POOL_WORDS } from "@/lib/relay";

describe("a person's run never goes backwards once it started", () => {
  it("started: Creating, a percent or Almost done; not In line or Getting ready", () => {
    expect(startedWords("Creating")).toBe(true);
    expect(startedWords("Creating · 40% · about 3 min left")).toBe(true);
    expect(startedWords(POOL_WORDS.finishing)).toBe(true);
    expect(startedWords(POOL_WORDS.gettingReady)).toBe(false);
    expect(startedWords(POOL_WORDS.inLine)).toBe(false);
    expect(startedWords(null)).toBe(false);
  });

  it("not started yet: shown as it is", () => {
    expect(heldRun({ status: "queued", message: POOL_WORDS.inLine, progress: null }, null, false)).toBeNull();
    expect(heldRun({ status: "running", message: POOL_WORDS.gettingReady, progress: null }, undefined, true)).toBeNull();
  });

  it("back in line, or getting ready again: Creating with no percent, at the highest share shown", () => {
    expect(heldRun({ status: "queued", message: POOL_WORDS.inLine, progress: null }, 0.42, false)).toEqual({ status: "running", message: "Creating", progress: 0.42 });
    expect(heldRun({ status: "running", message: "Creating", progress: 0.03 }, 0.42, true)).toEqual({ status: "running", message: "Creating", progress: 0.42 });
    // Started before any share was shown: Creating, and still no share.
    expect(heldRun({ status: "queued", message: POOL_WORDS.inLine, progress: null }, 0, false)).toEqual({ status: "running", message: "Creating", progress: null });
  });

  it("a new attempt below the peak: no percent, the time left may stay; past it, its own words and share again", () => {
    expect(heldRun({ status: "running", message: "Creating · 20% · about 4 min left", progress: 0.2 }, 0.42, false)).toEqual({ status: "running", message: "Creating · about 4 min left", progress: 0.42 });
    expect(heldRun({ status: "running", message: "Creating · 60%", progress: 0.5 }, 0.42, false)).toBeNull();
    expect(heldRun({ status: "running", message: "Creating · 40%", progress: 0.42 }, 0.42, false)).toBeNull();
  });

  it("finishing with no share to show stays Almost done; a run that ended is shown as it is", () => {
    expect(heldRun({ status: "running", message: POOL_WORDS.finishing, progress: null }, 0.9, false)).toBeNull();
    expect(heldRun({ status: "succeeded", message: null, progress: 1 }, 0.9, false)).toBeNull();
    expect(heldRun({ status: "failed", message: null, progress: null }, 0.9, false)).toBeNull();
  });
});
