import "server-only";
import type { Client } from "pg";
import { prisma } from "@/lib/db";
import { quoteIdent } from "@/lib/backup/tables";

/**
 * The inventory of uploaded files referenced by the database.
 *
 * Student documents and photos do not live in Postgres — they are in Vercel
 * Blob in production, on disk in development (src/lib/storage.ts). Dumping the
 * tables therefore saves every *reference* to a file and none of the bytes, so
 * the archive carries this manifest alongside: one entry per stored file, with
 * the row that points at it and whatever size and type were recorded at upload.
 *
 * It serves two purposes. After a restore it says exactly which files the
 * database expects, so a missing one is a line of output rather than a student
 * record that looks fine until somebody opens the document tab. And it is the
 * work list the backup agent follows when it is asked to pull the bytes down
 * too (`--with-files`).
 */

type FileSource = {
  table: string;
  /** Primary key column, so a manifest entry names the row to look at. */
  idColumn: string;
  pathColumn: string;
  fileNameColumn?: string;
  mimeTypeColumn?: string;
  sizeColumn?: string;
  /** What this file is, in words, for whoever is reading a restore report. */
  what: string;
};

/**
 * Every column known to hold a storage path.
 *
 * Written out rather than guessed, because a wrong guess here is silent. The
 * drift check below is what stops the list going stale: it asks the database
 * whether anything *else* looks like a storage path, so adding an upload column
 * without adding it here shows up in the manifest instead of being skipped.
 */
const FILE_SOURCES: FileSource[] = [
  {
    table: "Institute",
    idColumn: "id",
    pathColumn: "logoStoragePath",
    fileNameColumn: "logoFileName",
    mimeTypeColumn: "logoMimeType",
    sizeColumn: "logoSizeBytes",
    what: "Institute logo, printed on every generated PDF",
  },
  {
    table: "InstituteConfig",
    idColumn: "id",
    pathColumn: "paymentQrStoragePath",
    fileNameColumn: "paymentQrFileName",
    mimeTypeColumn: "paymentQrMimeType",
    sizeColumn: "paymentQrSizeBytes",
    what: "Bank-issued payment QR shown to applicants",
  },
  {
    table: "Application",
    idColumn: "id",
    pathColumn: "photoPath",
    what: "Applicant photograph",
  },
  {
    table: "ApplicationDocument",
    idColumn: "id",
    pathColumn: "storagePath",
    fileNameColumn: "fileName",
    mimeTypeColumn: "mimeType",
    sizeColumn: "sizeBytes",
    what: "Uploaded admission document",
  },
  {
    table: "Student",
    idColumn: "id",
    pathColumn: "photoPath",
    what: "Student photograph",
  },
];

export type ManifestEntry = {
  storagePath: string;
  table: string;
  rowId: string;
  what: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
};

export type FileManifest = {
  entries: ManifestEntry[];
  /** Distinct paths, which is what matters for completeness. */
  fileCount: number;
  /** Sum of recorded sizes, where a size was recorded at all. */
  knownBytes: number;
  /**
   * Columns that look like they hold a storage path but are not in
   * `FILE_SOURCES`. Always expected to be empty; anything here means an upload
   * column was added and this file was not updated, so the files it points at
   * are not being inventoried.
   */
  unrecognisedColumns: string[];
};

/** True when the table actually exists in this database. */
async function tableExists(client: Client, table: string): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    `SELECT to_regclass('public.' || quote_ident($1)) IS NOT NULL AS ok`,
    [table],
  );
  return rows[0]?.ok === true;
}

/**
 * Asks the database whether any column outside `FILE_SOURCES` looks like it
 * holds a storage path. Deliberately narrow — it matches the naming the app
 * already uses rather than anything ending in "path", so it stays quiet unless
 * something genuinely new turns up.
 */
async function findUnrecognisedColumns(client: Client): Promise<string[]> {
  const declared = FILE_SOURCES.map((source) => `${source.table}.${source.pathColumn}`);
  const { rows } = await client.query<{ label: string }>(
    `SELECT table_name || '.' || column_name AS label
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('text', 'character varying')
        AND (column_name ILIKE '%storagepath'
          OR column_name ILIKE '%photopath'
          OR column_name ILIKE '%filepath')
      ORDER BY 1`,
  );
  return rows.map((row) => row.label).filter((label) => !declared.includes(label));
}

/**
 * Builds the manifest. Must be called inside the same transaction as the table
 * dump, so the files it lists are the ones the dumped rows refer to.
 */
export async function buildFileManifest(client: Client): Promise<FileManifest> {
  const entries: ManifestEntry[] = [];

  for (const source of FILE_SOURCES) {
    // A database mid-migration may not have every table yet — the dump is still
    // worth taking, so skip rather than fail.
    if (!(await tableExists(client, source.table))) continue;

    const columns = [
      `${quoteIdent(source.idColumn)} AS "rowId"`,
      `${quoteIdent(source.pathColumn)} AS "storagePath"`,
      source.fileNameColumn ? `${quoteIdent(source.fileNameColumn)} AS "fileName"` : `NULL AS "fileName"`,
      source.mimeTypeColumn ? `${quoteIdent(source.mimeTypeColumn)} AS "mimeType"` : `NULL AS "mimeType"`,
      source.sizeColumn ? `${quoteIdent(source.sizeColumn)} AS "sizeBytes"` : `NULL AS "sizeBytes"`,
    ].join(", ");

    const { rows } = await client.query<{
      rowId: string;
      storagePath: string;
      fileName: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
    }>(
      `SELECT ${columns}
         FROM public.${quoteIdent(source.table)}
        WHERE ${quoteIdent(source.pathColumn)} IS NOT NULL
          AND ${quoteIdent(source.pathColumn)} <> ''
        ORDER BY 1`,
    );

    for (const row of rows) {
      entries.push({
        storagePath: row.storagePath,
        table: source.table,
        rowId: String(row.rowId),
        what: source.what,
        fileName: row.fileName,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
      });
    }
  }

  // The same file can be referenced twice — a photo carried from application to
  // student record — and should be fetched and counted once.
  const distinct = new Set(entries.map((entry) => entry.storagePath));
  const knownBytes = [...distinct].reduce((total, path) => {
    const size = entries.find((entry) => entry.storagePath === path)?.sizeBytes;
    return total + (size ?? 0);
  }, 0);

  return {
    entries,
    fileCount: distinct.size,
    knownBytes,
    unrecognisedColumns: await findUnrecognisedColumns(client),
  };
}

/**
 * Whether any row actually references this storage path.
 *
 * This is the guard on the file-fetch endpoint. Rather than sanitise a
 * caller-supplied path and hope, the path must be one the database itself
 * points at, so the endpoint can only ever return a file the application
 * already stored and traversal has nothing to reach for.
 *
 * Unlike `buildFileManifest` this runs as an ordinary application query on the
 * shared pooled connection, not inside the dump's transaction: the agent asks
 * for files one at a time, long after the snapshot was taken, and opening a
 * dedicated Postgres connection per file would exhaust the pool for no gain.
 */
export async function isReferencedStoragePath(path: string): Promise<boolean> {
  if (!isPlausibleStoragePath(path)) return false;

  // Built from the same FILE_SOURCES the manifest uses, so a column added there
  // is fetchable here without a second list to keep in step.
  const checks = FILE_SOURCES.map(
    (source) =>
      `SELECT 1 FROM public.${quoteIdent(source.table)} WHERE ${quoteIdent(source.pathColumn)} = $1 LIMIT 1`,
  );

  for (const sql of checks) {
    try {
      const rows = await prisma.$queryRawUnsafe<unknown[]>(sql, path);
      if (Array.isArray(rows) && rows.length > 0) return true;
    } catch {
      // A table this database does not have yet (a migration not applied here)
      // simply cannot be the one referencing the file.
    }
  }
  return false;
}

/**
 * Cheap structural check applied before the database is asked anything.
 *
 * Storage paths are generated by `persist()` in src/lib/storage.ts and are
 * always relative, slash-separated and free of traversal. Rejecting anything
 * else up front keeps an obviously hostile path from reaching a query at all.
 */
export function isPlausibleStoragePath(path: string): boolean {
  if (!path || path.length > 400) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  if (path.includes("..") || path.includes("\0")) return false;
  // Printable ASCII only; generated names are UUIDs under a known folder.
  return /^[A-Za-z0-9._/-]+$/.test(path);
}
