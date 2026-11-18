import { describe, expect, it } from "vitest";
import { PROMPT_HELPER_FILES } from "@/lib/comfy";
import { graphOptionalNeeds } from "@/lib/runtime-files";
import { loadIndex } from "@/server/gpu/index-file";

/**
 * A workflow's optional files that a run's graph loads (an opt-in Prompt helper's model when it is on, a decoder an option
 * picks) are files that run needs on the worker: a worker checks every file a graph loads, so the queue offers the task
 * only to a worker that verified them.
 */

const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });

describe("graphOptionalNeeds", () => {
  it.each(["minimax-h3-image-edit", "minimax-h3-image-t2i"])("%s: the Prompt helper's model when the graph loads it, nothing when it doesn't", (id) => {
    const index = loadIndex();
    const wf = index.workflows[id];
    expect(wf, id).toBeTruthy();
    const helper = index.files[PROMPT_HELPER_FILES[id] as keyof typeof index.files];
    expect(helper, "the helper's file is pinned in the index").toBeTruthy();
    expect(wf.optional).toContain(PROMPT_HELPER_FILES[id]);
    const base = Object.fromEntries(wf.files.map((k, i) => [String(i + 1), node("Loader", { name: index.files[k]?.file ?? k })]));
    expect(graphOptionalNeeds(base, index, id)).toEqual([]);
    const on = { ...base, "10": node("CLIPLoader", { clip_name: helper.file, type: "qwen_image" }) };
    expect(graphOptionalNeeds(on, index, id)).toEqual([{ folder: helper.folder, name: helper.file, size: helper.sizeBytes, sha256: helper.sha256 ?? null }]);
  });

  it("an unknown workflow, or one with no optional files, needs nothing more", () => {
    const index = loadIndex();
    expect(graphOptionalNeeds({ "1": node("CLIPLoader", { clip_name: "x.safetensors" }) }, index, "no-such-workflow")).toEqual([]);
  });
});
