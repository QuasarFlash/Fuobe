import { describe, expect, it } from "vitest";
import { cleanMarks, MARK_MAX, MARKS_MAX } from "@/lib/model-marks";

/** The billing service's words for open models in the model menu, as the site keeps them. */
describe("cleanMarks", () => {
  it("keeps short words by model id, folded and trimmed", () => {
    expect(cleanMarks({ a: " Pro ", b: "In\ncluded", c: "", d: 5, e: "x".repeat(MARK_MAX + 1) })).toEqual({ a: "Pro", b: "In cluded" });
  });
  it("null for nothing kept or not an object", () => {
    expect(cleanMarks(null)).toBeNull();
    expect(cleanMarks(["Pro"])).toBeNull();
    expect(cleanMarks({ a: "" })).toBeNull();
  });
  it("at most MARKS_MAX models", () => {
    const many = Object.fromEntries(Array.from({ length: MARKS_MAX + 20 }, (_, i) => [`m${i}`, "Pro"]));
    expect(Object.keys(cleanMarks(many)!)).toHaveLength(MARKS_MAX);
  });
});
