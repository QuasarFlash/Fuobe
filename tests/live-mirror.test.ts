/**
 * Live edit's Mirror mode (src/lib/live/mirror.ts): expression scores and the head's pose become a short, steady,
 * positive phrase; jitter never resends; one render at a time; and every graph it sends is Fuobe's live edit graph.
 */
import { describe, expect, it } from "vitest";
import { buildLiveGraph, liveGraphProblem, MAX_GRAPH_PROMPT, slotBindings } from "@/lib/live/graph";
import { FEATURE_NAMES, levelOf, levelsOf, featuresOf, mirrorPrompt, MirrorPacer, MirrorReader, NEUTRAL_LEVELS, phraseOf, poseOf, signedLevelOf, type Levels } from "@/lib/live/mirror";
import { cameraProblemOf } from "@/lib/live/mirror-camera";
import { MAX_LIVE_TEXT, normalize } from "@/lib/live/text";

const RAD = Math.PI / 180;
/** A column-major 4x4 from a 3x3 rotation given by its columns (side, up, forward), with a translation. */
const mat = (side: number[], up: number[], fwd: number[], k = 1) => [...side.map((v) => v * k), 0, ...up.map((v) => v * k), 0, ...fwd.map((v) => v * k), 0, 1, -2, -40, 1];
const rotY = (d: number) => mat([Math.cos(d * RAD), 0, -Math.sin(d * RAD)], [0, 1, 0], [Math.sin(d * RAD), 0, Math.cos(d * RAD)]);
const rotX = (d: number) => mat([1, 0, 0], [0, Math.cos(d * RAD), Math.sin(d * RAD)], [0, -Math.sin(d * RAD), Math.cos(d * RAD)]);
const rotZ = (d: number) => mat([Math.cos(d * RAD), Math.sin(d * RAD), 0], [-Math.sin(d * RAD), Math.cos(d * RAD), 0], [0, 0, 1]);

const lv = (o: Partial<Levels>): Levels => ({ ...NEUTRAL_LEVELS, ...o });

describe("poseOf", () => {
  it("reads yaw, pitch and roll as seen in the mirrored self-view", () => {
    expect(poseOf(rotY(0))).toEqual({ yaw: 0, pitch: 0, roll: 0 });
    // The face turns toward the camera image's right (the person's own left): the mirror shows it on the frame's left.
    expect(poseOf(rotY(20))!.yaw).toBeCloseTo(-20);
    expect(poseOf(rotY(-15))!.yaw).toBeCloseTo(15);
    // Forward pointing up is the chin going up.
    expect(poseOf(rotX(-12))!.pitch).toBeCloseTo(12);
    expect(poseOf(rotX(18))!.pitch).toBeCloseTo(-18);
    // The image's right side going up tilts the head top toward the image's left: the frame's right in the mirror.
    expect(poseOf(rotZ(14))!.roll).toBeCloseTo(14);
  });

  it("ignores scale and refuses what isn't a matrix", () => {
    expect(poseOf(mat([Math.cos(20 * RAD), 0, -Math.sin(20 * RAD)], [0, 1, 0], [Math.sin(20 * RAD), 0, Math.cos(20 * RAD)], 3.5))!.yaw).toBeCloseTo(-20);
    expect(poseOf(null)).toBeNull();
    expect(poseOf([1, 2, 3])).toBeNull();
    expect(poseOf(new Array(16).fill(0))).toBeNull();
    expect(poseOf([NaN, ...new Array(15).fill(1)])).toBeNull();
  });
});

describe("levels", () => {
  it("sticks to the level it has until a value is clearly past a cut", () => {
    const cuts = [0.25, 0.55];
    expect(levelOf(0.28, 0, cuts, 0.06)).toBe(0);
    expect(levelOf(0.32, 0, cuts, 0.06)).toBe(1);
    expect(levelOf(0.21, 1, cuts, 0.06)).toBe(1);
    expect(levelOf(0.18, 1, cuts, 0.06)).toBe(0);
    expect(levelOf(0.9, 0, cuts, 0.06)).toBe(2);
    expect(levelOf(0.05, 2, cuts, 0.06)).toBe(0);
  });

  it("a signed value changes side from level 0", () => {
    const cuts = [10, 24];
    expect(signedLevelOf(-12, 0, cuts, 3)).toBe(0);
    expect(signedLevelOf(-14, 0, cuts, 3)).toBe(-1);
    expect(signedLevelOf(-8, -1, cuts, 3)).toBe(-1);
    expect(signedLevelOf(30, -1, cuts, 3)).toBe(2);
    expect(signedLevelOf(12, -1, cuts, 3)).toBe(0);
  });

  it("reads the 52 scores by their names", () => {
    const f = featuresOf({ mouthSmileLeft: 0.8, mouthSmileRight: 0.6, jawOpen: 0.4, eyeBlinkLeft: 0.9, eyeBlinkRight: 0.1, browOuterUpLeft: 0.2, browInnerUp: 0.5 }, null);
    expect(f.smile).toBeCloseTo(0.7);
    expect(f.lopsided).toBeCloseTo(0.2);
    expect(f.wink).toBeCloseTo(0.8);
    expect(f.browUp).toBe(0.5);
    expect(f.yaw).toBe(0);
  });
});

describe("phraseOf", () => {
  it("a still face is calm and faces the camera", () => {
    expect(phraseOf(NEUTRAL_LEVELS)).toBe("with a calm, relaxed expression, facing the camera");
  });

  it("names the mouth, brows, eyes and head in plain words", () => {
    const f = featuresOf({ mouthSmileLeft: 0.7, mouthSmileRight: 0.7, jawOpen: 0.35, browInnerUp: 0.4, eyeBlinkLeft: 0.45, eyeBlinkRight: 0.45 }, poseOf(rotY(15)));
    expect(phraseOf(levelsOf(f))).toBe("smiling widely with the mouth open, eyebrows slightly raised, eyes half closed, head turned slightly toward the left of the frame");
    expect(phraseOf(lv({ smile: 2, jaw: 2, browUp: 2, yaw: 2, pitch: 1 }))).toBe("laughing with the mouth wide open, eyebrows raised high, head turned toward the right of the frame, chin slightly raised");
    expect(phraseOf(lv({ pucker: 1, smile: 2 }))).toBe("lips puckered as if blowing a kiss, facing the camera");
    expect(phraseOf(lv({ smile: 1, lopsided: 1, browOne: 1, wink: 1 }))).toBe("with a lopsided smirk, one eyebrow raised, winking one eye, facing the camera");
    expect(phraseOf(lv({ blink: 2, lookUp: 1 }))).toBe("eyes closed, facing the camera");
    expect(phraseOf(lv({ frown: 1, browDown: 1, pitch: -2, roll: -1 }))).toBe("the corners of the mouth turned down, brows furrowed, head bowed, head tilted slightly toward the left of the frame");
  });

  it("is always positive, short and stable under the live text rules", () => {
    // Deterministic samples of every feature's levels.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const widest: Levels = lv({ smile: 1, lopsided: 1, jaw: 1, frown: 1, sneer: 1, browUp: 1, blink: 1, lookDown: 1, yaw: -1, pitch: -1, roll: -1 });
    const samples: Levels[] = [widest];
    for (let i = 0; i < 4000; i++) {
      const l = {} as Levels;
      for (const k of FEATURE_NAMES) {
        const n = k === "smile" || k === "jaw" || k === "browUp" || k === "blink" ? 3 : k === "yaw" || k === "pitch" || k === "roll" ? 5 : 2;
        const v = Math.floor(rnd() * n);
        l[k] = k === "yaw" || k === "pitch" || k === "roll" ? v - 2 : v;
      }
      samples.push(l);
    }
    for (const l of samples) {
      const p = phraseOf(l);
      const prompt = mirrorPrompt(p);
      expect(p).not.toMatch(/\b(no|not|without|never|don't|avoid|less|un\w+)\b/i);
      expect(prompt).not.toMatch(/\b(no|not|without|never|don't|avoid)\b/i);
      expect(prompt.length).toBeLessThan(MAX_LIVE_TEXT);
      expect(normalize(prompt)).toBe(prompt.replace(/\.$/, ""));
      expect(prompt).toContain(p);
    }
  });
});

describe("MirrorReader", () => {
  const smile = (v: number) => ({ scores: { mouthSmileLeft: v, mouthSmileRight: v }, matrix: rotY(0) });

  it("jitter around a cut changes nothing", () => {
    const r = new MirrorReader({ alpha: 1, holdMs: 0 });
    let t = 0;
    const first = r.push(smile(0.1), (t += 66));
    expect(first).toMatchObject({ face: true, changed: false, phrase: "with a calm, relaxed expression, facing the camera" });
    for (const v of [0.24, 0.28, 0.22, 0.3, 0.26, 0.2]) expect(r.push(smile(v), (t += 66)).changed).toBe(false);
  });

  it("a held change counts; a moment's twitch doesn't", () => {
    const r = new MirrorReader({ alpha: 1, holdMs: 150 });
    let t = 0;
    r.push(smile(0), t);
    // One frame of a wide smile, then back.
    expect(r.push(smile(0.8), (t += 66)).changed).toBe(false);
    expect(r.push(smile(0), (t += 66)).changed).toBe(false);
    expect(r.phrase).toBe("with a calm, relaxed expression, facing the camera");
    // Held for longer than holdMs.
    const seen = [66, 66, 66, 66].map(() => r.push(smile(0.8), (t += 66)));
    expect(seen.map((x) => x.changed)).toEqual([false, false, false, true]);
    expect(r.phrase).toBe("smiling widely, facing the camera");
  });

  it("smooths the scores, and keeps the phrase while no face is seen", () => {
    const r = new MirrorReader({ alpha: 0.5, holdMs: 0 });
    r.push(smile(0), 0);
    // Smoothed: one 0.9 frame lands at 0.45 (soft), a second at 0.675 (wide).
    expect(r.push(smile(0.9), 66).phrase).toBe("smiling softly, facing the camera");
    expect(r.push(smile(0.9), 132).phrase).toBe("smiling widely, facing the camera");
    expect(r.push(null, 200)).toEqual({ phrase: "smiling widely, facing the camera", face: false, changed: false });
    r.reset();
    expect(r.phrase).toBe("with a calm, relaxed expression, facing the camera");
  });
});

describe("MirrorPacer", () => {
  it("one render in flight, and only a changed phrase", () => {
    const p = new MirrorPacer();
    expect(p.take()).toBeNull();
    p.want("a");
    expect(p.take()).toBe("a");
    expect(p.inFlight).toBe(true);
    p.want("b");
    p.want("c");
    expect(p.take()).toBeNull();
    p.done("ok");
    // The newest only: b is never sent.
    expect(p.take()).toBe("c");
    p.done("ok");
    expect(p.take()).toBeNull();
    p.want("c");
    expect(p.take()).toBeNull();
  });

  it("a dropped render goes again; a failed one waits for a change", () => {
    const p = new MirrorPacer();
    p.want("a");
    p.take();
    p.done("dropped");
    expect(p.take()).toBe("a");
    p.done("error");
    expect(p.take()).toBeNull();
    p.want("b");
    expect(p.take()).toBe("b");
    p.done("ok");
    p.resend();
    expect(p.take()).toBe("b");
    p.done("ok");
    p.reset();
    expect(p.take()).toBeNull();
  });
});

describe("Mirror's renders", () => {
  const NAME = (n: number) => `fuobe_lv${String(n).padStart(20, "A")}.png`;
  it("are Fuobe's live edit graph: the check accepts them as they are", () => {
    const prompts = [phraseOf(NEUTRAL_LEVELS), phraseOf(lv({ smile: 1, lopsided: 1, jaw: 1, sneer: 1, browUp: 1, blink: 1, lookDown: 1, yaw: -1, pitch: -1, roll: -1 }))].map(mirrorPrompt);
    for (const text of prompts) {
      for (const mask of [undefined, NAME(2)]) {
        // What the transports build for a live slot: the text as the model reads it, on the base picture.
        const bind = slotBindings("live", { liveSize: 512, keepRes: 1024, hasMask: !!mask, to: "socket", liveLongSide: 640 });
        const { graph, staged } = buildLiveGraph({ prompt: normalize(text), seed: 1234, ...bind, base: NAME(1), ...(mask && { mask }) });
        expect(liveGraphProblem(graph, staged)).toBeNull();
        expect((graph["30"].inputs.prompt as string).length).toBeLessThanOrEqual(MAX_GRAPH_PROMPT);
        expect(graph["10"].inputs.image).toBe(NAME(1));
      }
    }
  });
});

describe("cameraProblemOf", () => {
  it("names why the camera didn't open", () => {
    expect(cameraProblemOf({ name: "NotAllowedError" })).toBe("blocked");
    expect(cameraProblemOf({ name: "NotFoundError" })).toBe("none");
    expect(cameraProblemOf({ name: "NotReadableError" })).toBe("busy");
    expect(cameraProblemOf({ name: "BrowserError" })).toBe("browser");
    expect(cameraProblemOf(new Error("network"))).toBe("load");
    expect(cameraProblemOf(null)).toBe("load");
  });
});
