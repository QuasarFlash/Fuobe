import "server-only";
import type { MediaKind, Operation } from "@/lib/catalog/types";
import { needsEnglish } from "@/lib/prompt-language";
import { llmText, type LlmTextOptions } from "./enhance";

/**
 * A prompt in another language, in English for the model: picture and video models follow English prompts best. The
 * person keeps seeing their own words; only the model gets the English version. It runs only when needsEnglish says the
 * prompt is in another language, and only for operations whose prompt describes the picture or the clip (never words to
 * be spoken, sung, written or translated). With no text helper, or an answer that doesn't look like a prompt, the run
 * keeps the words as typed.
 */

/** The most a prompt is sent for an English version (longer ones go as they are). */
export const ENGLISH_MAX_CHARS = 2000;

/** The operations whose prompt says what the picture or clip shows: these get the English version. */
const DESCRIBES = new Set<Operation>(["t2i", "edit", "inpaint", "outpaint", "t2v", "i2v", "flf2v", "ref2v", "v2v", "extend", "motion-transfer", "remove-object", "video-swap", "video-insert", "keyframes", "text-to-3d"]);

export const takesEnglish = (kind: MediaKind, op: Operation): boolean => (kind === "image" || kind === "video" || kind === "model3d") && DESCRIBES.has(op);

/** Would a run's prompt get an English version (another language, an operation that describes, not too long)? */
export const wantsEnglish = (prompt: string | undefined, kind: MediaKind, op: Operation): boolean =>
  !!prompt && prompt.length <= ENGLISH_MAX_CHARS && takesEnglish(kind, op) && needsEnglish(prompt);

export const ENGLISH_SYSTEM = `You translate prompts for image and video generation models into English.
Rules:
- Answer with the English prompt only: no preamble, no notes, no quotes around the answer.
- Translate every word, also words typed without their accents. Keep the meaning, every detail and the order. Add nothing new.
- Keep exactly as written and in the same place: words inside quotes, names, brands, @handles, tags in angle brackets such as <Picture 1>, references such as "Image 1", numbers and units.
- Say only what the result should show. Never write not, no, without or don't: write what should be there instead.
- An edit instruction stays an instruction: say what to change and to what, and what to keep the same.
Examples:
camasa trebuie sa fie alba, nu albastru deschis ca acum
Make the shirt white.
quita el sombrero y que no tenga gafas
Remove the hat and the glasses.
<Picture 1> в красном платье, без шляпы
<Picture 1> in a red dress, bare head.
Mach den Himmel klar, ohne Wolken, und ändere das Auto nicht
Make the sky clear and cloudless, and keep the car the same.`;

/** The helper's answer as a prompt: trimmed, a wrapper of quotes or a "Prompt:" label taken off; null when it isn't one. */
export function cleanEnglish(answer: string | null | undefined, original: string): string | null {
  if (!answer) return null;
  let s = answer.replace(/^```\w*\n?|```$/g, "").trim();
  s = s.replace(/^(english( prompt)?|prompt|translation)\s*:\s*/i, "").trim();
  if (/^(["“'])[\s\S]*(["”'])$/.test(s) && !/^["“']/.test(original.trim())) s = s.slice(1, -1).trim();
  if (!s) return null;
  // A prompt, not a chat: far longer than the words given means the model said more than the prompt.
  if (s.length > original.length * 3 + 200) return null;
  return s;
}

/**
 * The English version of a run's prompt, or null when the run keeps its words (English already, an operation whose words
 * aren't a description, too long, or no helper answered). `ask` is the text helper (llmText), replaced in tests.
 */
export async function englishPrompt(
  prompt: string,
  kind: MediaKind,
  op: Operation,
  o: { open?: boolean; waitMs?: number; ask?: (system: string, user: string, opts: LlmTextOptions) => Promise<string | null> } = {},
): Promise<string | null> {
  if (!wantsEnglish(prompt, kind, op)) return null;
  const ask = o.ask ?? llmText;
  // The open engine's runs are free: a local model or the free helper, never a paid API.
  const answer = await ask(ENGLISH_SYSTEM, prompt, { task: "translate", waitMs: o.waitMs ?? 20_000, timeoutMs: 30_000, ...(o.open && { ollamaOnly: true }) }).catch(() => null);
  const english = cleanEnglish(answer, prompt);
  return english && english !== prompt ? english : null;
}
