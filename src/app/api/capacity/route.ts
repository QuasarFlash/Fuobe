import { connection } from "next/server";
import { capacityView } from "@/server/capacity";
import { hostedRunsOn } from "@/server/hosted-switch";

/**
 * The lengths and sizes runs on this install's GPUs are made at now (src/server/capacity.ts): by model, only the ones
 * limited now. Read by the composer for a visitor's runs there; the same answer for everyone, kept a few seconds.
 */
export async function GET() {
  await connection();
  return Response.json(hostedRunsOn() ? capacityView() : { m: {} }, { headers: { "Cache-Control": "private, max-age=5" } });
}
