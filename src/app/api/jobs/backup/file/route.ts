import { NextResponse } from "next/server";
import { authorizeJobRequest } from "@/lib/job-auth";
import { isReferencedStoragePath } from "@/lib/backup/manifest";
import { readStoredFile } from "@/lib/storage";

/**
 * One uploaded file, by its storage path, for the backup agent.
 *
 * The archive from /api/jobs/backup carries every row and an inventory of the
 * uploaded files, but not the files themselves — they live in Vercel Blob, and
 * copying all of them through a 60-second function would not finish once there
 * is real data. The agent instead walks the manifest and asks for them here,
 * one at a time, with no time limit because it is running on the office PC.
 *
 * Two gates stand in front of it. The job secret, as with every /api/jobs
 * route; and the path having to be one the *database* actually references, so
 * this cannot be turned into a way to read arbitrary blobs. Normal document
 * access for signed-in staff is unchanged and still goes through
 * /api/documents/[id], which checks permissions per student.
 */

export const maxDuration = 60;

async function sendFile(request: Request): Promise<Response> {
  const denied = authorizeJobRequest(request);
  if (denied) return denied;

  const path = new URL(request.url).searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "A `path` query parameter is required." }, { status: 400 });
  }

  // Not 403: whether a given path exists is exactly what an unreferenced path
  // should not reveal, so an unknown path and a hostile one answer alike.
  if (!(await isReferencedStoragePath(path))) {
    return NextResponse.json({ error: "No such file." }, { status: 404 });
  }

  const bytes = await readStoredFile(path);
  if (!bytes) {
    // Referenced by a row but missing from storage — a real finding, and the
    // reason the agent reports per-file failures rather than ignoring them.
    return NextResponse.json({ error: "File is referenced but missing from storage." }, { status: 410 });
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  return sendFile(request);
}

export async function POST(request: Request) {
  return sendFile(request);
}
