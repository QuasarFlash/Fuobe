import { describe, expect, it } from "vitest";
import type { Generation } from "@/lib/catalog/types";
import { withKeyAction, type TroubleAction } from "@/lib/diagnose";
import type { PoolRules } from "@/lib/pool-rules";
import { asksSiteFallback, movedWords, shownTroubleActions, SITE_FALLBACK_CAUSES, siteFallbackLabel, siteFallbackOf, siteFallbackQuestion, siteRunOf } from "@/lib/site-run";

/** "Run on {Place}" on a failed run (hosted runs): offered only for what this studio's GPUs take, on its open version. */
const trouble = { cause: "gpu-offline", words: "Your GPU isn't answering.", actions: [], retryable: false } as unknown as Generation["trouble"];
const run = (o: Partial<Generation>) =>
  ({ status: "failed", engine: "open", kind: "image", modelId: "oss-z-image-turbo", op: "t2i", presetId: null, trouble, ...o }) as Parameters<typeof siteRunOf>[0];

describe("Run on the place, on a run that failed on the person's own GPU or key", () => {
  it("an open run on its own GPU: the same model, while hosted runs are on", () => {
    expect(siteRunOf(run({}), true, undefined)).toEqual({ modelId: "oss-z-image-turbo" });
  });

  it("never off hosted runs, on a run there already, a run that didn't fail, or one with no trouble of its own", () => {
    expect(siteRunOf(run({}), false, undefined)).toBeNull();
    expect(siteRunOf(run({ place: "pool" }), true, undefined)).toBeNull();
    expect(siteRunOf(run({ status: "canceled" }), true, undefined)).toBeNull();
    expect(siteRunOf(run({ trouble: undefined }), true, undefined)).toBeNull();
  });

  it("never for what they don't take: a model that runs on an own setup only, or one their rules keep off", () => {
    expect(siteRunOf(run({ kind: "video", modelId: "oss-h3-regenerate", op: "upscale-video" }), true, undefined)).toBeNull();
    const rules: PoolRules = { deny: ["oss-z-image-turbo"] } as PoolRules;
    expect(siteRunOf(run({}), true, rules)).toBeNull();
    const apps: PoolRules = { apps: { deny: ["app-face-swap"] } } as PoolRules;
    expect(siteRunOf(run({ engine: "cloud", modelId: "nano-banana-pro", op: "edit", presetId: "app-face-swap" }), true, apps)).toBeNull();
  });

  it("a run its key turned down: the item's open version (an app's open route, a Fuobe Original on Open source)", () => {
    expect(siteRunOf(run({ engine: "cloud", modelId: "nano-banana-pro", op: "edit", presetId: "app-face-swap" }), true, undefined)).toEqual({
      modelId: "oss-qwen-image-21-turbo",
      op: "edit",
      engine: "open",
    });
    expect(siteRunOf(run({ engine: "cloud", modelId: "fuobe-soul" }), true, undefined)).toEqual({ modelId: "fuobe-soul", engine: "open" });
    // A cloud model with no open version: nothing to offer.
    expect(siteRunOf(run({ engine: "cloud", modelId: "nano-banana-pro", op: "edit" }), true, undefined)).toBeNull();
  });
});

describe("a failed run's key offer", () => {
  const unpriced = withKeyAction("fal", "nano-banana-pro");
  const priced = withKeyAction("fal", "nano-banana-pro", undefined, "≈ $0.04");
  const add: TroubleAction = { kind: "add-credit", label: "Add credit on fal.ai", target: "https://fal.ai" } as TroubleAction;

  it("shows only with its price while hosted runs are on", () => {
    expect(shownTroubleActions([add, unpriced], true)).toEqual([add]);
    expect(shownTroubleActions([add, priced], true)).toEqual([add, priced]);
  });

  it("is unchanged with hosted runs off", () => {
    const actions = [add, unpriced];
    expect(shownTroubleActions(actions, false)).toBe(actions);
  });
});

describe("a pick made anywhere moves the studios' engine", () => {
  it("to Cloud for the key, back to Open source away from it, and leaves the switch alone otherwise", async () => {
    const { keyEngine } = await import("@/lib/run-on");
    expect(keyEngine("site", "key")).toBe("cloud");
    expect(keyEngine(null, "key")).toBe("cloud");
    expect(keyEngine("key", "site")).toBe("open");
    expect(keyEngine("key", "gpu")).toBe("open");
    expect(keyEngine("gpu", "site")).toBeNull();
    expect(keyEngine(undefined, "gpu")).toBeNull();
  });
});

describe("a run refused there only for its LoRAs", () => {
  it("carries the way on to the composer's line", async () => {
    const { poolRunState } = await import("@/lib/hosted");
    const quote = { allowed: false, amount: 0, priceVersion: "", text: "LoRAs run on your own GPU", code: "not-offered", ownSetup: { need: "gpu" as const }, withoutLoras: true as const };
    expect(poolRunState({ quote } as never)).toMatchObject({ refused: true, withoutLoras: true, setup: { need: "gpu" } });
    expect(poolRunState({ quote: { ...quote, withoutLoras: undefined } } as never)?.withoutLoras).toBeUndefined();
  });
});

describe("Run on the place: the same offer on every card", () => {
  it("never on a run that went there by itself, or is on its way", () => {
    expect(siteRunOf(run({ movedTo: "g2" }), true, undefined)).toBeNull();
    expect(siteRunOf(run({ moving: true }), true, undefined)).toBeNull();
  });
});

describe("running there automatically when the person's GPU can't", () => {
  const own = (cause: string, o: Partial<Generation> = {}) => ({ ...run({ trouble: { cause, actions: [] } as unknown as Generation["trouble"], ...o }), provider: "comfyui" }) as Parameters<typeof siteFallbackOf>[0];

  it("takes the GPU's own troubles: off, stopped, out of memory, a missing model or add-on, a ComfyUI problem", () => {
    for (const cause of ["gpu-offline", "gpu-stopped", "gpu-went-away", "gpu-out-of-memory", "gpu-model-file", "gpu-refused", "gpu-job-error", "gpu-comfy-known", "gpu-error", "gpu-restarted"]) {
      expect(siteFallbackOf(own(cause), true, undefined), cause).toEqual({ modelId: "oss-z-image-turbo" });
    }
    for (const cause of ["gpu-offline", "gpu-out-of-memory", "gpu-model-file"]) expect(SITE_FALLBACK_CAUSES.has(cause as never)).toBe(true);
  });

  it("never for the person's own files or words, a run they stopped, or anything off their own GPU", () => {
    for (const cause of ["bad-input", "content-flag", "gpu-too-big", "gpu-slow-upload", "gpu-stopped-run", "key-balance", "key-rejected", "unknown"]) {
      expect(siteFallbackOf(own(cause), true, undefined), cause).toBeNull();
    }
    // Its key, not its GPU.
    expect(siteFallbackOf({ ...own("gpu-offline"), provider: "fal", engine: "cloud" } as never, true, undefined)).toBeNull();
    // On this install's GPUs already, off hosted runs, no trouble, or moved already.
    expect(siteFallbackOf(own("gpu-offline", { place: "pool" }), true, undefined)).toBeNull();
    expect(siteFallbackOf(own("gpu-offline"), false, undefined)).toBeNull();
    expect(siteFallbackOf({ ...own("gpu-offline"), trouble: undefined }, true, undefined)).toBeNull();
    expect(siteFallbackOf(own("gpu-offline", { movedTo: "g2" }), true, undefined)).toBeNull();
    // What their rules keep off is never sent there.
    expect(siteFallbackOf(own("gpu-offline"), true, { deny: ["oss-z-image-turbo"] } as PoolRules)).toBeNull();
  });

  it("asks once: an account with hosted runs on that never answered, after a run on its own GPU", () => {
    const g = { provider: "comfyui" } as Generation;
    expect(asksSiteFallback({ kind: "account", hosted: true }, g)).toBe(true);
    // Answered either way: never again.
    expect(asksSiteFallback({ kind: "account", hosted: true, siteFallback: "off" }, g)).toBe(false);
    expect(asksSiteFallback({ kind: "account", hosted: true, siteFallback: "on" }, g)).toBe(false);
    // Not for a run on its key, a guest, or with hosted runs off.
    expect(asksSiteFallback({ kind: "account", hosted: true }, { provider: "fal" } as Generation)).toBe(false);
    expect(asksSiteFallback({ kind: "guest", hosted: true }, g)).toBe(false);
    expect(asksSiteFallback({ kind: "account", hosted: false }, g)).toBe(false);
    expect(asksSiteFallback(undefined, g)).toBe(false);
  });

  it("says plainly where a moved run went, with no price or usage words", () => {
    expect(siteFallbackQuestion("our GPUs")).toBe("Next time, run on our GPUs automatically when your GPU can't?");
    expect(movedWords({ movedTo: "g2" }, "our GPUs")).toBe("Your GPU couldn't run this, so it's running on our GPUs.");
    expect(movedWords({ moving: true }, "our GPUs")).toBe("Your GPU couldn't run this, so it's going to our GPUs.");
    expect(movedWords({}, "our GPUs")).toBeNull();
    for (const w of [siteFallbackQuestion("our GPUs"), siteFallbackLabel("our GPUs"), movedWords({ movedTo: "x" }, "our GPUs")!]) {
      expect(w).not.toMatch(/\d|%|price|cost|uses|credit|\$/i);
    }
  });
});

describe("a list keeps asking while a failed run is on its way there", () => {
  it("counts a moving run as on its way, and stops once it moved", async () => {
    const { pollDelay } = await import("@/lib/generation-stream");
    const now = 1_000_000;
    expect(pollDelay([{ status: "failed", createdAt: now - 1000 }], false, now)).toBeNull();
    expect(pollDelay([{ status: "failed", createdAt: now - 1000, moving: true }], false, now)).toBe(1500);
  });
});
