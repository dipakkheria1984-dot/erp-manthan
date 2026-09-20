import { NextResponse } from "next/server";
import { z } from "zod";
import { refuseBridge } from "@/lib/tally/bridge-auth";
import { leaseTallyJobs } from "@/lib/tally/outbox";

/**
 * POST /api/tally/pull — the bridge on the Tally PC collecting work.
 *
 * Doubles as its heartbeat: every poll is recorded, with whether the bridge
 * could see Tally, so Setup › Tally can say plainly when vouchers are stuck
 * because the office PC is off or Tally is closed. A bridge that cannot see
 * Tally asks for `limit: 0` — heartbeat only — so nothing is leased that it
 * could not deliver.
 */

export const maxDuration = 60;

const bodySchema = z.object({
  limit: z.number().int().min(0).max(50).default(10),
  tallyOnline: z.boolean().default(false),
});

export async function POST(request: Request) {
  const refused = refuseBridge(request);
  if (refused) return refused;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  try {
    const result = await leaseTallyJobs(parsed.data.limit, { tallyOnline: parsed.data.tallyOnline });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[tally:pull]", error);
    return NextResponse.json({ error: "Could not collect Tally jobs." }, { status: 500 });
  }
}
