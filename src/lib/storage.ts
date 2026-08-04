import "server-only";
import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { put, del, get } from "@vercel/blob";
import { env } from "@/lib/env";
import { ValidationError } from "@/lib/errors";

/**
 * Document storage. Nothing else in the app touches a filesystem or a bucket —
 * every caller works in terms of the relative, slash-separated `storagePath`
 * recorded on the database row.
 *
 * Two drivers sit behind that path, chosen by whether `BLOB_READ_WRITE_TOKEN`
 * is set:
 *
 * - **Local disk** (development). Everything lives under `UPLOAD_DIR`. Moving
 *   the app to another machine only means copying that directory across.
 * - **Vercel Blob** (production). A serverless filesystem is ephemeral — a
 *   file written during one request is gone by the next deploy, and often
 *   sooner — so uploads have to leave the instance.
 *
 * Because the storage path is the blob's pathname verbatim (`addRandomSuffix`
 * is off; the UUID name generated here is already unique), the same database
 * row resolves under either driver.
 *
 * Blobs are written with `access: "private"`, so they are reachable only with
 * the store token and never by URL. That is deliberate: student documents are
 * served through `/api/documents/[id]`, which checks permissions first, and a
 * publicly-addressable bucket would quietly route around that check.
 */

/** True when uploads should go to Vercel Blob rather than the local disk. */
function usingBlobStore(): boolean {
  return env.blobToken !== "";
}

const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png"]);
const ALLOWED_EXT = new Set([".pdf", ".jpg", ".jpeg", ".png"]);

/**
 * Images embedded in generated PDFs — currently the institute logo. Narrower
 * than `ALLOWED_MIME` on purpose: pdfkit can only embed PNG and JPEG, so an SVG
 * or PDF logo would upload happily and then fail to print.
 */
const IMAGE_MIME = new Set(["image/jpeg", "image/png"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png"]);

/**
 * Spreadsheets for bulk import. Browsers report CSV inconsistently
 * (`text/csv`, `application/vnd.ms-excel`, sometimes empty), so the extension
 * is the reliable signal here and the MIME type is only advisory.
 */
const SPREADSHEET_EXT = new Set([".csv", ".xlsx"]);

export type StoredFile = {
  fileName: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
};

export function validateUpload(file: File): void {
  if (file.size === 0) {
    throw new ValidationError("The selected file is empty.");
  }
  const maxBytes = env.maxUploadMb * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new ValidationError(`File is too large. The limit is ${env.maxUploadMb} MB.`);
  }
  const ext = path.extname(file.name).toLowerCase();
  if (!ALLOWED_MIME.has(file.type) || !ALLOWED_EXT.has(ext)) {
    throw new ValidationError("Only PDF, JPG and PNG files are accepted.");
  }
}

export function validateImageUpload(file: File): void {
  if (file.size === 0) {
    throw new ValidationError("The selected file is empty.");
  }
  const maxBytes = env.maxUploadMb * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new ValidationError(`Image is too large. The limit is ${env.maxUploadMb} MB.`);
  }
  const ext = path.extname(file.name).toLowerCase();
  if (!IMAGE_MIME.has(file.type) || !IMAGE_EXT.has(ext)) {
    throw new ValidationError("Upload a PNG or JPG image.");
  }
}

export function validateSpreadsheet(file: File): ".csv" | ".xlsx" {
  if (file.size === 0) {
    throw new ValidationError("The selected file is empty.");
  }
  const maxBytes = env.maxUploadMb * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new ValidationError(`File is too large. The limit is ${env.maxUploadMb} MB.`);
  }
  const ext = path.extname(file.name).toLowerCase();
  if (!SPREADSHEET_EXT.has(ext)) {
    throw new ValidationError("Upload a .csv or .xlsx file.");
  }
  return ext as ".csv" | ".xlsx";
}

/**
 * Writes `file` into `folder` under a generated name. The client-supplied name
 * is never used on disk — only recorded, so the UI can show what was uploaded.
 * The returned storage path is relative and slash-separated, so a database
 * written on Windows still resolves on a Linux host.
 */
async function persist(file: File, folder: string, ext: string, mimeType: string): Promise<StoredFile> {
  const safeName = `${randomUUID()}${ext}`;
  const storagePath = `${folder}/${safeName}`;

  if (usingBlobStore()) {
    await put(storagePath, file, {
      access: "private",
      // The name is already a UUID, so a suffix would only make the stored
      // path differ from what we record on the row.
      addRandomSuffix: false,
      contentType: mimeType,
      token: env.blobToken,
    });
  } else {
    const absoluteDir = path.resolve(env.uploadDir, folder);
    await mkdir(absoluteDir, { recursive: true });
    await writeFile(path.join(absoluteDir, safeName), Buffer.from(await file.arrayBuffer()));
  }

  return {
    fileName: file.name,
    storagePath,
    mimeType,
    sizeBytes: file.size,
  };
}

/** Stores a spreadsheet for the two-step import (preview, then commit). */
export async function storeSpreadsheet(file: File, folder: string): Promise<StoredFile> {
  const ext = validateSpreadsheet(file);
  const fallback =
    ext === ".csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return persist(file, folder, ext, file.type || fallback);
}

export async function storeUpload(file: File, folder: string): Promise<StoredFile> {
  validateUpload(file);
  return persist(file, folder, path.extname(file.name).toLowerCase(), file.type);
}

/** Stores an image destined to be embedded in a PDF — see `IMAGE_MIME`. */
export async function storeImage(file: File, folder: string): Promise<StoredFile> {
  validateImageUpload(file);
  const ext = path.extname(file.name).toLowerCase();
  // `.jpg` and `.jpeg` are the same format; record the reported type so the
  // serving route sends a header browsers agree with.
  return persist(file, folder, ext, file.type || (ext === ".png" ? "image/png" : "image/jpeg"));
}

/**
 * Bytes of a stored file, or null when it is no longer there. This is the only
 * read path — callers that used to resolve an absolute path and open the file
 * themselves go through here, so both drivers stay interchangeable.
 */
export async function readStoredFile(storagePath: string): Promise<Buffer | null> {
  if (usingBlobStore()) {
    try {
      const result = await get(storagePath, { access: "private", token: env.blobToken });
      // 304 only arrives in response to `ifNoneMatch`, which we never send.
      if (!result || result.statusCode !== 200) return null;
      return Buffer.from(await new Response(result.stream).arrayBuffer());
    } catch {
      return null;
    }
  }

  try {
    return await readFile(absolutePathFor(storagePath));
  } catch {
    return null;
  }
}

/**
 * Local-disk path for a storage path. Only meaningful under the local driver —
 * the blob store has no filesystem — so nothing outside this module should
 * reach for it. Use `readStoredFile` instead.
 */
function absolutePathFor(storagePath: string): string {
  const resolved = path.resolve(env.uploadDir, storagePath);
  const root = path.resolve(env.uploadDir);
  // Guard against a stored path escaping the upload root.
  if (!resolved.startsWith(root)) {
    throw new ValidationError("Invalid file path.");
  }
  return resolved;
}

export async function deleteUpload(storagePath: string): Promise<void> {
  if (usingBlobStore()) {
    try {
      await del(storagePath, { token: env.blobToken });
    } catch {
      // Already gone — the database row is the source of truth.
    }
    return;
  }

  try {
    await unlink(absolutePathFor(storagePath));
  } catch {
    // Already gone — the database row is the source of truth.
  }
}
