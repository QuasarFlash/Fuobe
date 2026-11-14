import { connection } from "next/server";
import { z } from "zod";
import { requestAccount } from "@/server/auth";
import { poolReady } from "@/server/hosted";
import { setSiteFallback, siteFallbackFor } from "@/server/site-fallback";

/**
 * "Run on {Place} automatically when your GPU can't" (hosted runs on): the account's answer, kept for every device. The
 * one-time question after its first "Run on {Place}" and Settings → Where your runs go write it (`{ on }`; Not now is
 * `false`, and is kept as an answer too). GET reads it: `{ siteFallback: "on" | "off" | null }` (null: never asked).
 * Accounts only, each its own. While hosted runs are off this route doesn't exist (404).
 */
const NO_STORE = { "Cache-Control": "no-store" };
const answer = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: NO_STORE });
const notHere = () => answer(404, { error: "Not found" });

const Body = z.object({ on: z.boolean() }).strict();

export async function GET(request: Request): Promise<Response> {
  await connection();
  if (!poolReady()) return notHere();
  const a = requestAccount(request);
  if (!a) return notHere();
  return answer(200, { siteFallback: siteFallbackFor(a.id) ?? null });
}

export async function PUT(request: Request): Promise<Response> {
  if (!poolReady()) return notHere();
  const a = requestAccount(request);
  if (!a) return notHere();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return answer(400, { error: "Say yes or not now." });
  setSiteFallback(a.id, parsed.data.on);
  return answer(200, { siteFallback: siteFallbackFor(a.id) ?? null });
}
