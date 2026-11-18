import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeFal, type FakeCloud } from "./helpers/fake-cloud";
import { tempDir } from "./helpers/temp-dir";

/**
 * A prompt in another language reaches the model in English, and the run keeps the words as typed. The text helper is a
 * stand-in (llmText), and fal.ai is the stand-in of tests/helpers/fake-cloud.ts: no real key, no paid call.
 */
process.env.FUOBE_DATA_DIR = tempDir("fuobe-english-prompt-");
process.env.COMFYUI_URL = "http://127.0.0.1:9";
delete process.env.FUOBE_PASSWORD;
globalThis.__fuobeTestDiskFree = 1e13;

const asked: string[] = [];
let answer: string | null = "A model in a red silk dress on the beach, golden light";
vi.mock("@/server/enhance", async (original) => ({
  ...(await original<typeof import("@/server/enhance")>()),
  llmText: async (_system: string, user: string) => {
    asked.push(user);
    return answer;
  },
}));

const { setSetting } = await import("@/server/settings");
const { createGenerations, getGeneration } = await import("@/server/generations");
type GenerationRequest = import("@/lib/catalog/types").GenerationRequest;

let fal: FakeCloud;
beforeAll(async () => {
  fal = await startFakeFal();
  globalThis.__fuobeTestFalUrl = fal.url;
  fal.keys["stand-in-fal-key"] = "good";
  fal.pollsToFinish = 0;
  setSetting("falKey", "stand-in-fal-key");
});
afterAll(async () => {
  globalThis.__fuobeTestFalUrl = undefined;
  await fal.close();
});

/** One picture of `prompt` on Seedream 5 Pro: the prompt fal got, and the run as the person sees it. */
async function run(prompt: string): Promise<{ sent: string; shown: string }> {
  fal.log.length = 0;
  const [g] = createGenerations({ feature: "image", modelId: "seedream-5-pro", engine: "cloud", prompt } as GenerationRequest);
  for (let i = 0; i < 1500 && !["failed", "succeeded", "canceled"].includes(getGeneration(g.id)!.status); i++) await new Promise((r) => setTimeout(r, 10));
  const done = getGeneration(g.id)!;
  expect(done.status, done.error ?? "").toBe("succeeded");
  const submit = fal.log.find((r) => r.method === "POST" && !r.path.startsWith("/storage/"))!;
  return { sent: JSON.parse(submit.body).prompt, shown: done.prompt ?? "" };
}

describe("a prompt in another language", () => {
  it("goes to the model in English; the person still sees their own words", async () => {
    const hindi = "समुद्र तट पर लाल रेशमी पोशाक में एक मॉडल, सुनहरी रोशनी";
    const { sent, shown } = await run(hindi);
    expect(asked).toEqual([hindi]);
    expect(sent).toBe("A model in a red silk dress on the beach, golden light");
    expect(shown).toBe(hindi);
  });

  it("an English prompt goes as typed, with no helper asked", async () => {
    asked.length = 0;
    const { sent } = await run("A model in a red silk dress on the beach, golden light");
    expect(sent).toBe("A model in a red silk dress on the beach, golden light");
    expect(asked).toEqual([]);
  });

  it("with no helper answer, the words go as typed", async () => {
    answer = null;
    const ro = "o femeie cu rochie rosie pe plaja, fundal alb";
    const { sent } = await run(ro);
    expect(sent).toBe(ro);
  });
});
