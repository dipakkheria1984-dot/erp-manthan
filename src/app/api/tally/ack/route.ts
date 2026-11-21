import { NextResponse } from "next/server";
import { z } from "zod";
import { refuseBridge } from "@/lib/tally/bridge-auth";
import { acknowledgeTallyJob } from "@/lib/tally/outbox";

/**
 * POST /api/tally/ack — the bridge reporting what Tally said.
 *
 * The bridge forwards Tally's raw replies rather than interpreting them, so
 * the reading of Tally's answer lives in one place (src/lib/tally/voucher.ts)
 * and can be corrected without touching the office PC.
 */

const bodySchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string().min(1),
        transportError: z.string().max(2000).optional(),
        responses: z
          .array(
            z.object({
              purpose: z.enum(["ledger", "voucher"]),
              ledgerName: z.string().optional(),
              httpStatus: z.number().int(),
              body: z.string().max(20_000),
            }),
          )
          .optional(),
      }),
    )
    .max(50),
});

export async function POST(request: Request) {
  const refused = refuseBridge(request);
  if (refused) return refused;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid acknowledgement." }, { status: 400 });

  const outcomes: Record<string, string> = {};
  for (const result of parsed.data.results) {
    try {
      outcomes[result.id] = await acknowledgeTallyJob(result);
    } catch (error) {
      console.error("[tally:ack]", result.id, error);
      outcomes[result.id] = "error";
    }
  }
  return NextResponse.json({ ok: true, outcomes });
}
