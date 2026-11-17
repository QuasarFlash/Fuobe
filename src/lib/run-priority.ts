/**
 * A run's priority within its class on this install's GPUs, from an external service (billing.ts ReserveAnswer): 0 is
 * none, a higher number goes earlier in each round of the line (src/server/computer/pool.ts smartLine).
 */
export const MAX_PRIORITY = 9;

/** A priority as it may be kept: a whole number from 0 to MAX_PRIORITY (anything else is 0). */
export function cleanPriority(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0;
  return Math.max(0, Math.min(MAX_PRIORITY, n));
}
