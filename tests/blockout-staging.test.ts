import { describe, expect, it } from "vitest";
import { EXAMPLE_SCENE, aspectOf, cameraAt, lensVFov, type Vec3 } from "@/lib/blockout";
import { cameraTrail, clipTimeAt, frustumCorners, frustumDepth, piecePaths, timelineKey } from "@/lib/blockout-staging";

/** The Blockout staging view's maths: trails, paths, the frustum, a reference clip's time and the timeline keys. */

const close = (a: Vec3, b: Vec3, digits = 6) => a.forEach((n, i) => expect(n).toBeCloseTo(b[i], digits));

describe("cameraTrail", () => {
  it("runs from the first key to the last, with no shake", () => {
    const pts = cameraTrail(EXAMPLE_SCENE.camera, EXAMPLE_SCENE.duration, 10);
    expect(pts).toHaveLength(11);
    close(pts[0], EXAMPLE_SCENE.camera[0].position);
    close(pts[10], EXAMPLE_SCENE.camera[2].position);
  });
});

describe("piecePaths", () => {
  it("draws a path for a piece that travels, not for a door that only swings", () => {
    const paths = piecePaths(EXAMPLE_SCENE, 8);
    expect(paths.map((p) => p.id)).toEqual(["walker"]);
    expect(paths[0].points).toHaveLength(9);
    expect(paths[0].keys).toHaveLength(4);
    close(paths[0].points[8], [0, 0, -13.2]);
  });
});

describe("frustumCorners", () => {
  it("frames the lens's field of view around the line of sight", () => {
    const aspect = aspectOf("16:9");
    const [tl, tr, br, bl] = frustumCorners([0, 1, 0], [0, 1, -10], 28, aspect, 2);
    const half = Math.tan((lensVFov(28, aspect) * Math.PI) / 360) * 2;
    close(tl, [-half * aspect, 1 + half, -2]);
    close(tr, [half * aspect, 1 + half, -2]);
    close(br, [half * aspect, 1 - half, -2]);
    close(bl, [-half * aspect, 1 - half, -2]);
  });

  it("keeps a frame when the camera looks straight down", () => {
    const c = frustumCorners([0, 5, 0], [0, 0, 0], 50, 1, 1);
    for (const p of c) expect(p.every(Number.isFinite)).toBe(true);
    close(c[0].map((n, i) => (n + c[2][i]) / 2) as Vec3, [0, 4, 0]);
  });

  it("reaches out to what the camera looks at, within limits", () => {
    expect(frustumDepth([0, 0, 0], [0, 0, -4])).toBe(4);
    expect(frustumDepth([0, 0, 0], [0, 0, -0.2])).toBe(1.5);
    expect(frustumDepth([0, 0, 0], [0, 0, -50])).toBe(8);
    const c = cameraAt(EXAMPLE_SCENE.camera, 2);
    expect(frustumDepth(c.position, c.target)).toBeGreaterThan(1.5);
  });
});

describe("clipTimeAt", () => {
  it("follows the playhead from where the clip starts, and holds outside it", () => {
    expect(clipTimeAt(3, 1, 10)).toEqual({ time: 2, inside: true });
    expect(clipTimeAt(0.5, 1, 10)).toEqual({ time: 0, inside: false });
    expect(clipTimeAt(2, -3, 4)).toEqual({ time: 4 - 0.001, inside: false });
    expect(clipTimeAt(4, 0, NaN)).toEqual({ time: 4, inside: true });
  });
});

describe("timelineKey", () => {
  it("plays, steps a frame or a second, and jumps to the ends", () => {
    expect(timelineKey(" ", 1, 8)).toBe("toggle");
    expect(timelineKey("k", 1, 8)).toBe("toggle");
    expect(timelineKey(".", 1, 8)).toBeCloseTo(1 + 1 / 24, 9);
    expect(timelineKey(",", 0, 8)).toBe(0);
    expect(timelineKey("l", 7.5, 8)).toBe(8);
    expect(timelineKey("J", 2, 8)).toBe(1);
    expect(timelineKey("Home", 5, 8)).toBe(0);
    expect(timelineKey("End", 5, 8)).toBe(8);
    expect(timelineKey("ArrowLeft", 5, 8)).toBeNull();
  });
});
