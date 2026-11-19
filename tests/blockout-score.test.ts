import { describe, expect, it } from "vitest";
import { BLOCKOUT, EXAMPLE_SCENE, emptyScene, normalizeScene } from "@/lib/blockout";
import { SCORE, applyScore, parseScore, scoreFileName, scoreFromScene, scoreText, validateScore } from "@/lib/blockout-score";

/** The Blockout score: a scene's timeline as a text file, read back with plain messages, and brought in as a scene. */

const ok = (text: string) => {
  const r = parseScore(text);
  if (!r.ok) throw new Error(r.error);
  return r;
};
const fails = (raw: unknown) => {
  const r = typeof raw === "string" ? parseScore(raw) : validateScore(raw);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};

const SMALL = {
  score: 1,
  name: "Walk and turn",
  aspect: "2.39:1",
  camera: [
    { t: 0, position: [0, 1.6, 4], target: [0, 1.2, 0], lens: 35 },
    { t: 5, position: [2, 1.6, 2], target: [0, 1.2, -2], lens: 50, shake: 0.3 },
  ],
  actors: [{ name: "Hero", keys: [{ t: 0, position: [0, 0, 0], turn: 180 }, { t: 5, position: [0, 0, -4] }] }],
  markers: [{ t: 0, label: "Start" }, { t: 3, label: "Turn" }],
};

describe("parseScore", () => {
  it("reads a score, sorts keys and takes the length from the last key", () => {
    const { score, notes } = ok(JSON.stringify({ ...SMALL, camera: [...SMALL.camera].reverse() }));
    expect(notes).toEqual([]);
    expect(score.duration).toBe(5);
    expect(score.aspect).toBe("2.39:1");
    expect(score.camera!.map((k) => k.t)).toEqual([0, 5]);
    expect(score.camera![1].shake).toBe(0.3);
    expect(score.actors![0]).toMatchObject({ name: "Hero", keys: [{ t: 0, turn: 180 }, { t: 5 }] });
    expect(score.markers!.map((m) => m.label)).toEqual(["Start", "Turn"]);
  });

  it("round-trips the example scene through its own text", () => {
    const text = scoreText(scoreFromScene(EXAMPLE_SCENE));
    expect(text).toContain('{ "t": 0, "position": [0.35, 1.55, 1.8], "target": [0, 1.3, -6], "lens": 28, "shake": 0.45 }');
    const { score } = ok(text);
    expect(score).toEqual(scoreFromScene(EXAMPLE_SCENE));
    expect(applyScore(EXAMPLE_SCENE, score).scene).toEqual(normalizeScene(EXAMPLE_SCENE));
  });

  it("keeps the shortest blockout and the default lens", () => {
    const { score } = ok(JSON.stringify({ camera: [{ t: 0, position: [0, 1, 3], target: [0, 1, 0] }, { t: 1, position: [0, 1, 2], target: [0, 1, 0], lens: 85 }, { t: 1.5, position: [0, 1, 1], target: [0, 1, 0] }] }));
    expect(score.duration).toBe(BLOCKOUT.minSeconds);
    expect(score.camera!.map((k) => k.lens)).toEqual([BLOCKOUT.lens.default, 85, 85]);
  });

  it("brings numbers into range and says so", () => {
    const { score, notes } = ok(JSON.stringify({ duration: 400, camera: [{ t: -2, position: [9999, 1, 0], target: [0, 0, 0], lens: 5, shake: 3 }] }));
    expect(score.duration).toBe(BLOCKOUT.maxSeconds);
    expect(score.camera![0]).toEqual({ t: 0, position: [SCORE.reach, 1, 0], target: [0, 0, 0], lens: BLOCKOUT.lens.min, shake: 1 });
    expect(notes[0]).toMatch(/^5 numbers were outside what Blockout allows/);
  });

  it("says when keys fall after the given length", () => {
    const { score, notes } = ok(JSON.stringify({ duration: 4, actors: [{ name: "A", keys: [{ t: 0, position: [0, 0, 0] }, { t: 9, position: [1, 0, 0] }] }] }));
    expect(score.duration).toBe(4);
    expect(notes).toEqual(["1 key after the end (4 s) lands on the last frame."]);
  });

  it("strips a byte-order mark and blank space", () => {
    expect(ok(`﻿  ${JSON.stringify(SMALL)}\n`).score.name).toBe("Walk and turn");
  });

  it("refuses bad files in plain words", () => {
    expect(fails("")).toBe("This file is empty.");
    expect(fails("x".repeat(SCORE.maxChars + 1))).toMatch(/too big/);
    expect(fails('{\n  "camera": [\n    { "t": 0 }\n    { "t": 1 }\n  ]\n}')).toMatch(/^This isn't a score Blockout can read: check near line 4/);
    expect(fails([])).toMatch(/starts with \{/);
    expect(fails({ score: 2, camera: [] })).toBe("This score was written for a newer version of Blockout.");
    expect(fails({ score: "one" })).toBe('"score" should be 1.');
    expect(fails({ camera: [] })).toMatch(/no camera keys and no actors/);
    expect(fails({ camera: {} })).toBe('"camera" should be a list in [ ].');
    expect(fails({ camera: [{ position: [0, 0, 0], target: [0, 0, 1] }] })).toBe('Camera key 1 needs a time "t" in seconds.');
    expect(fails({ camera: [{ t: 0, position: [0, 0], target: [0, 0, 1] }] })).toBe('Camera key 1: "position" needs three numbers, like [0, 1.6, 4].');
    expect(fails({ camera: [{ t: 0, position: [0, 0, 0], target: [0, "a", 1] }] })).toMatch(/^Camera key 1: "target" needs three numbers/);
    expect(fails({ camera: [{ t: 0, position: [0, 0, 0], target: [0, 0, 1], lens: "wide" }] })).toBe("Camera key 1 needs the lens in mm as a number.");
    expect(fails({ camera: ["key"] })).toBe("Camera key 1 should be written inside { }.");
    expect(fails({ actors: [{ name: "Ann", keys: [] }] })).toBe('Actor 1 (Ann) needs at least one key in "keys".');
    expect(fails({ actors: [{ name: "Ann", kind: "dragon", keys: [{ t: 0, position: [0, 0, 0] }] }] })).toMatch(/^Actor 1: "kind" can be box, wall/);
    expect(fails({ actors: [{ name: 3, keys: [{ t: 0, position: [0, 0, 0] }] }] })).toBe('Actor 1: "name" should be words in quotes.');
    expect(fails({ actors: [{ name: "Ann", keys: [{ t: 1, position: [0, 0, 0], turn: "left" }] }] })).toBe("Actor 1 (Ann), key 1 needs a turn in degrees as a number.");
    expect(fails({ ...SMALL, aspect: "wide" })).toBe('"aspect" should look like "16:9".');
    expect(fails({ ...SMALL, duration: "long" })).toBe('The score needs "duration" in seconds as a number.');
    expect(fails({ ...SMALL, markers: [{ t: 1, label: 7 }] })).toBe('Marker 1: "label" should be words in quotes.');
  });

  it("caps the key and actor counts", () => {
    const key = (t: number) => ({ t, position: [0, 1, 2], target: [0, 1, 0] });
    expect(fails({ camera: Array.from({ length: SCORE.maxCameraKeys + 1 }, (_, i) => key(i / 10)) })).toBe(`A score holds up to ${SCORE.maxCameraKeys} camera keys; this one has ${SCORE.maxCameraKeys + 1}.`);
    const actor = { name: "A", keys: [{ t: 0, position: [0, 0, 0] }] };
    expect(fails({ actors: Array.from({ length: SCORE.maxActors + 1 }, () => actor) })).toMatch(/^A score holds up to 24 actors/);
    expect(fails({ actors: [{ name: "A", keys: Array.from({ length: SCORE.maxActorKeys + 1 }, (_, i) => ({ t: i / 10, position: [0, 0, 0] })) }] })).toMatch(/keys per actor/);
    expect(ok(JSON.stringify({ camera: Array.from({ length: SCORE.maxCameraKeys }, (_, i) => key(i / 10)) })).score.camera).toHaveLength(SCORE.maxCameraKeys);
  });
});

describe("applyScore", () => {
  it("moves a piece of the same name, adds the rest, and keeps the set", () => {
    const base = emptyScene();
    const { score } = ok(JSON.stringify(SMALL));
    const first = applyScore(base, score);
    expect(first).toMatchObject({ moved: 0, added: 1, dropped: 0 });
    const s = first.scene;
    expect(s.name).toBe("Walk and turn");
    expect(s.aspect).toBe("2.39:1");
    expect(s.duration).toBe(5);
    expect(s.prims[0].kind).toBe("floor");
    const hero = s.prims[1];
    expect(hero).toMatchObject({ kind: "mannequin", name: "Hero", position: [0, 0, 0], rotation: 180 });
    // A key with no turn keeps the one before.
    expect(hero.keys).toEqual([
      { t: 0, position: [0, 0, 0], rotation: 180 },
      { t: 5, position: [0, 0, -4], rotation: 180 },
    ]);
    expect(s.camera).toHaveLength(2);
    expect(s.camera[0].shake).toBe(0);

    // The same score again moves the hero instead of adding a second one, and the markers keep their ids.
    const again = applyScore(s, score);
    expect(again).toMatchObject({ moved: 1, added: 0 });
    expect(again.scene.prims).toHaveLength(2);
    expect(again.scene.markers.map((m) => m.id)).toEqual(s.markers.map((m) => m.id));
  });

  it("matches by id before name, and keeps the scene's camera and markers when the score has none", () => {
    const { score } = ok(JSON.stringify({ duration: 8, actors: [{ id: "door", name: "Anything", keys: [{ t: 1, position: [-0.5, 0, -12], turn: 0 }, { t: 2, position: [-0.5, 0, -12], turn: 90 }] }] }));
    const { scene, moved } = applyScore(EXAMPLE_SCENE, score);
    expect(moved).toBe(1);
    const door = scene.prims.find((p) => p.id === "door")!;
    expect(door.kind).toBe("door");
    expect(door.keys!.map((k) => k.rotation)).toEqual([0, 90]);
    expect(scene.camera).toEqual(normalizeScene(EXAMPLE_SCENE).camera);
    expect(scene.markers).toEqual(normalizeScene(EXAMPLE_SCENE).markers);
  });

  it("drops actors past the most pieces a blockout holds", () => {
    const full = { ...emptyScene(), prims: Array.from({ length: BLOCKOUT.maxPrims }, (_, i) => ({ ...emptyScene().prims[0], id: `f${i}`, name: `Floor ${i}` })) };
    const { score } = ok(JSON.stringify({ actors: [{ name: "Late", keys: [{ t: 0, position: [0, 0, 0] }] }] }));
    expect(applyScore(full, score)).toMatchObject({ added: 0, dropped: 1 });
  });

  it("adds a mesh actor as a box (it has no model of its own)", () => {
    const { score } = ok(JSON.stringify({ actors: [{ name: "Car", kind: "mesh", keys: [{ t: 0, position: [1, 0, 0] }, { t: 2, position: [5, 0, 0] }] }] }));
    expect(applyScore(emptyScene(), score).scene.prims[1]).toMatchObject({ kind: "box", name: "Car" });
  });
});

describe("scoreFileName", () => {
  it("makes a plain file name", () => {
    expect(scoreFileName("Corridor and door")).toBe("corridor-and-door.score.json");
    expect(scoreFileName("  ")).toBe("blockout.score.json");
  });
});
