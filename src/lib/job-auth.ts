import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";

/**
 * Authentication for the scheduled endpoints under /api/jobs/*.
 *
 * Two callers, two shapes, and every job route accepts both:
 *
 * - **POST** with `x-job-secret: $JOB_SECRET` — any external scheduler, and
 *   what the `npm run job:*` scripts and the backup agent use.
 * - **GET** with `Authorization: Bearer $CRON_SECRET` — Vercel Cron, which only
 *   issues GET and cannot be given a custom header.
 *
 * Kept in one place because it is the only thing standing in front of jobs that
 * read the whole database, and a comparison that leaks timing or an unset
 * secret that defaults to open should be a mistake available in one file rather
 * than copied into each route.
 */

/** Constant-time compare, so a wrong secret leaks nothing through timing. */
export function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Checks a job request. Returns `null` when the caller is allowed through, or
 * the response to send back when it is not — so a route reads:
 *
 *     const denied = authorizeJobRequest(request);
 *     if (denied) return denied;
 *
 * An unconfigured secret answers 503 rather than 401: the endpoint is shut, but
 * the operator is told it is shut because nothing was set, not because they got
 * the value wrong.
 */
export function authorizeJobRequest(request: Request): NextResponse | null {
  if (request.method === "POST") {
    if (!env.jobSecret) {
      return NextResponse.json({ error: "JOB_SECRET is not configured." }, { status: 503 });
    }
    if (!secretMatches(request.headers.get("x-job-secret"), env.jobSecret)) {
      return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
    }
    return null;
  }

  if (!env.cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  }
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!secretMatches(bearer, env.cronSecret)) {
    return NextResponse.json({ error: "Unauthorised." }, { status: 401 });
  }
  return null;
}
