import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";

/**
 * The bridge authenticates with `x-tally-key`. Returns a response to send back
 * when it should be refused, or null when it may proceed.
 */
export function refuseBridge(request: Request): NextResponse | null {
  if (!env.tallyBridgeKey) {
    return NextResponse.json({ error: "TALLY_BRIDGE_KEY is not configured." }, { status: 503 });
  }
  const provided = request.headers.get("x-tally-key");
  if (!provided) return NextResponse.json({ error: "Unauthorised." }, { status: 401 });

  // Constant-time, so a wrong key leaks nothing through timing.
  const a = Buffer.from(provided);
  const b = Buffer.from(env.tallyBridgeKey);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }
  return null;
}
