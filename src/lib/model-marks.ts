/**
 * The short words a model menu shows on the right of an open model instead of "Free", by model id, when the billing
 * service's policy gives them (Policy.marks) and the viewer's runs go to this install's GPUs. Fuobe has no such words of
 * its own: with no service, or none sent, every open model shows "Free" as before.
 */
export type ModelMarks = Record<string, string>;

/** The longest word kept (characters); a longer one is left out. */
export const MARK_MAX = 12;
/** The most models a policy may mark. */
export const MARKS_MAX = 500;

/** A policy's marks as kept: string ids and words only, control characters out, spaces folded. Null when none is left. */
export function cleanMarks(raw: unknown): ModelMarks | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: ModelMarks = {};
  let n = 0;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MARKS_MAX) break;
    if (typeof value !== "string" || !id || id.length > 120) continue;
    const s = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
    if (!s || s.length > MARK_MAX) continue;
    out[id] = s;
    n++;
  }
  return n ? out : null;
}
