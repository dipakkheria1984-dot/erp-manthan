#!/usr/bin/env node
/**
 * Manthan ERP — monthly backup agent.
 *
 * Runs on the office PC. Once a month it pulls a full, consistent copy of the
 * ERP database down to this machine, checks it is complete, and keeps the last
 * few months' copies.
 *
 * The copy lands on hardware that neither the hosting account nor the database
 * provider can take with them, which is the whole point: a backup held in the
 * same account as the live data protects against a mistake, not against losing
 * the account.
 *
 * What it does, in order:
 *   1. asks the ERP for an archive (/api/jobs/backup) and streams it to a
 *      `.part` file, so a half-finished download is never mistaken for a backup,
 *   2. reads the archive back and verifies it — right format, every table
 *      present, row counts matching the archive's own trailer,
 *   3. only then renames it into place and writes a `.sha256` next to it,
 *   4. optionally pulls the uploaded documents and photos too (--with-files),
 *   5. deletes copies older than the retention window.
 *
 * No dependencies — Node 18 or later is all it needs.
 *
 * Configuration comes from environment variables, or from `backup.env` beside
 * this file (KEY=value per line):
 *   ERP_URL          https://your-erp.example.com            (required)
 *   ERP_JOB_SECRET   same value as JOB_SECRET on the ERP     (required)
 *   BACKUP_DIR       where archives are kept                 (default ./archives)
 *   RETAIN_MONTHS    how many months to keep                 (default 12)
 *   WITH_FILES       true to pull documents as well          (default false)
 *   FILE_CONCURRENCY parallel file downloads                 (default 4)
 *
 * Flags:
 *   --if-due       do nothing if this month already has a verified backup.
 *                  The scheduled task uses this, so a PC that was switched off
 *                  on the 1st still gets the month's backup when it next runs.
 *   --with-files   pull the uploaded files too, regardless of WITH_FILES.
 *   --verify-only  re-check the archives already on disk and exit.
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(HERE, "backup.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/* ---------------------------------------------------------------- config -- */

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(join(HERE, "backup.env"));

const ARGV = new Set(process.argv.slice(2));

/** An absolute path is used as given; anything else sits beside this script. */
function resolveDir(value, fallback) {
  if (!value) return join(HERE, fallback);
  return /^([A-Za-z]:|\\\\|\/)/.test(value) ? value : join(HERE, value);
}

const ERP_URL = (process.env.ERP_URL ?? "").replace(/\/$/, "");
const ERP_JOB_SECRET = process.env.ERP_JOB_SECRET ?? "";
const BACKUP_DIR = resolveDir(process.env.BACKUP_DIR, "archives");
const RETAIN_MONTHS = Math.max(1, Number.parseInt(process.env.RETAIN_MONTHS ?? "12", 10) || 12);
const WITH_FILES = ARGV.has("--with-files") || /^(1|true|yes)$/i.test(process.env.WITH_FILES ?? "");
const FILE_CONCURRENCY = Math.min(16, Math.max(1, Number.parseInt(process.env.FILE_CONCURRENCY ?? "4", 10) || 4));
const IF_DUE = ARGV.has("--if-due");
const VERIFY_ONLY = ARGV.has("--verify-only");

const ARCHIVE_RE = /^manthan-backup-(\d{4})-(\d{2})-(\d{2})\.ndjson\.gz$/;

/* --------------------------------------------------------------- logging -- */

function log(level, message) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;
  (level === "ERROR" ? console.error : console.log)(line);
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // A full disk is reported by the backup failing, not by logging failing.
  }
}

/* ------------------------------------------------------------------ time -- */

/**
 * Today in the institute's own time zone. The ERP runs as IST and its months
 * end at IST midnight, so a backup taken late in the evening here must not be
 * filed under the wrong month.
 */
function istParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day") };
}

function istDateStamp(date = new Date()) {
  const { year, month, day } = istParts(date);
  return `${year}-${month}-${day}`;
}

function istMonthStamp(date = new Date()) {
  const { year, month } = istParts(date);
  return `${year}-${month}`;
}

/* ------------------------------------------------------------------ http -- */

function jobRequest(path, timeoutMs) {
  return fetch(`${ERP_URL}${path}`, {
    method: "POST",
    headers: { "x-job-secret": ERP_JOB_SECRET },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/* -------------------------------------------------------------- download -- */

async function download(partPath) {
  // Generous on purpose: the ERP's own function ceiling will cut a runaway dump
  // long before this does, and a slow office line should not be the thing that
  // fails a backup.
  const response = await jobRequest("/api/jobs/backup", 15 * 60_000);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // A failing ERP answers with a whole HTML error page, which is no use in a
    // log. Say what the status actually means for this setup instead.
    const hint = {
      404: "The ERP has no /api/jobs/backup route. Is a version with the backup code deployed?",
      401: "ERP_JOB_SECRET does not match JOB_SECRET on the ERP.",
      503: "JOB_SECRET is not configured on the ERP.",
    }[response.status];
    const body = /^\s*<(!doctype|html)/i.test(detail) ? "" : detail.trim().slice(0, 200);
    throw new Error(
      [`/api/jobs/backup answered HTTP ${response.status}.`, hint, body && `Response: ${body}`]
        .filter(Boolean)
        .join(" "),
    );
  }
  if (!response.body) throw new Error("The ERP returned no body for the archive.");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partPath));
  return statSync(partPath).size;
}

/* ---------------------------------------------------------------- verify -- */

/**
 * Reads an archive back and decides whether it is a backup or just a file.
 *
 * The check that matters is the trailer. The ERP writes it only after every
 * table has been read, and it carries the row count per table — so a download
 * that was cut short, a dump that hit a timeout, or a disk that filled up all
 * fail here rather than sitting in the folder looking like insurance.
 */
async function verifyArchive(path) {
  let header = null;
  let manifest = null;
  let trailer = null;
  let currentTable = null;
  const counts = {};
  let lineNo = 0;

  const lines = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    lineNo += 1;
    if (!line.trim()) continue;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Archive is corrupt: line ${lineNo} is not valid JSON.`);
    }

    if (parsed.header) {
      header = parsed.header;
      if (header.format !== "manthan-erp-backup") {
        throw new Error(`Unexpected archive format "${header.format}".`);
      }
      continue;
    }
    if (parsed.table) {
      currentTable = parsed.table;
      counts[currentTable] = 0;
      continue;
    }
    if (parsed.row) {
      if (!currentTable) {
        throw new Error(`Archive is corrupt: a row at line ${lineNo} precedes any table.`);
      }
      counts[currentTable] += 1;
      continue;
    }
    if (parsed.manifest) {
      manifest = parsed.manifest;
      continue;
    }
    if (parsed.trailer) {
      trailer = parsed.trailer;
    }
  }

  if (!header) throw new Error("Archive has no header — it is not a Manthan backup.");
  if (!trailer || trailer.complete !== true) {
    throw new Error(
      "Archive has no completion trailer, so the dump did not finish. " +
        "It has NOT been kept. Check the ERP's logs and run the backup again.",
    );
  }

  // The archive states what it should contain; this is where that claim is
  // actually tested against what arrived.
  for (const [table, expected] of Object.entries(trailer.counts ?? {})) {
    const actual = counts[table] ?? 0;
    if (actual !== expected) {
      throw new Error(`Archive is short: ${table} has ${actual} rows, the trailer claims ${expected}.`);
    }
  }
  for (const table of header.tableOrder ?? []) {
    if (!(table in counts)) throw new Error(`Archive is missing the table ${table} entirely.`);
  }

  if (header.cyclicTables?.length) {
    log(
      "WARN",
      `Tables in a foreign-key cycle: ${header.cyclicTables.join(", ")}. A restore needs the two-pass path.`,
    );
  }
  if (manifest?.unrecognisedColumns?.length) {
    log(
      "WARN",
      `These columns look like file paths but are not inventoried: ${manifest.unrecognisedColumns.join(", ")}. ` +
        "Add them to FILE_SOURCES in src/lib/backup/manifest.ts.",
    );
  }

  return { header, manifest, trailer, counts };
}

function sha256OfFile(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

/* ----------------------------------------------------------------- files -- */

/**
 * Pulls the uploaded documents and photos listed in the manifest.
 *
 * Files already present with the expected size are left alone, so a monthly run
 * only fetches what is new. A file the database references but storage no
 * longer has is reported rather than skipped quietly — that is a real gap in
 * the records, and the backup run is the moment it is cheapest to notice.
 */
async function pullFiles(manifest, filesDir) {
  const entries = [...new Map((manifest?.entries ?? []).map((entry) => [entry.storagePath, entry])).values()];
  if (entries.length === 0) {
    log("INFO", "No uploaded files are referenced.");
    return { fetched: 0, skipped: 0, missing: [], failed: [] };
  }

  mkdirSync(filesDir, { recursive: true });
  let fetched = 0;
  let skipped = 0;
  const missing = [];
  const failed = [];
  let next = 0;

  async function worker() {
    for (;;) {
      const entry = entries[next++];
      if (!entry) return;

      const target = join(filesDir, ...entry.storagePath.split("/"));
      if (existsSync(target) && (entry.sizeBytes == null || statSync(target).size === entry.sizeBytes)) {
        skipped += 1;
        continue;
      }

      const query = `path=${encodeURIComponent(entry.storagePath)}`;
      try {
        const response = await jobRequest(`/api/jobs/backup/file?${query}`, 120_000);
        if (response.status === 410) {
          missing.push(entry.storagePath);
          continue;
        }
        if (!response.ok) {
          failed.push(`${entry.storagePath} (HTTP ${response.status})`);
          continue;
        }

        mkdirSync(dirname(target), { recursive: true });
        const part = `${target}.part`;
        await pipeline(Readable.fromWeb(response.body), createWriteStream(part));

        const size = statSync(part).size;
        if (entry.sizeBytes != null && size !== entry.sizeBytes) {
          rmSync(part, { force: true });
          failed.push(`${entry.storagePath} (got ${size} bytes, expected ${entry.sizeBytes})`);
          continue;
        }
        renameSync(part, target);
        fetched += 1;
        if (fetched % 25 === 0) log("INFO", `  ...${fetched} files fetched`);
      } catch (error) {
        failed.push(`${entry.storagePath} (${error instanceof Error ? error.message : error})`);
      }
    }
  }

  await Promise.all(Array.from({ length: FILE_CONCURRENCY }, worker));
  return { fetched, skipped, missing, failed };
}

/* ----------------------------------------------------------------- prune -- */

function listArchives(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, match: ARCHIVE_RE.exec(name) }))
    .filter((entry) => entry.match !== null)
    .map((entry) => ({
      name: entry.name,
      path: join(dir, entry.name),
      date: `${entry.match[1]}-${entry.match[2]}-${entry.match[3]}`,
      month: `${entry.match[1]}-${entry.match[2]}`,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Keeps the newest `RETAIN_MONTHS` *months*, not the newest N files.
 *
 * Retention counted in files would quietly shorten the window every time
 * somebody ran an extra backup by hand — which is exactly when they are being
 * careful, and the worst moment to start discarding history.
 */
function prune(dir) {
  const archives = listArchives(dir);
  const months = [...new Set(archives.map((archive) => archive.month))].sort((a, b) => b.localeCompare(a));
  const keep = new Set(months.slice(0, RETAIN_MONTHS));

  let removed = 0;
  for (const archive of archives) {
    if (keep.has(archive.month)) continue;
    rmSync(archive.path, { force: true });
    rmSync(`${archive.path}.sha256`, { force: true });
    rmSync(archive.path.replace(/\.ndjson\.gz$/, ".manifest.json"), { force: true });
    removed += 1;
    log("INFO", `Pruned ${archive.name} (outside the ${RETAIN_MONTHS}-month window).`);
  }
  if (removed === 0) log("INFO", `Nothing to prune; holding ${months.length} month(s).`);
}

/* ------------------------------------------------------------------ main -- */

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Re-checks every archive already on disk. A backup nobody ever reads back is a guess. */
async function verifyOnly() {
  const archives = listArchives(BACKUP_DIR);
  if (archives.length === 0) {
    log("ERROR", `No archives found in ${BACKUP_DIR}.`);
    return false;
  }

  let allGood = true;
  for (const archive of archives) {
    try {
      const { trailer } = await verifyArchive(archive.path);
      const sidecar = `${archive.path}.sha256`;
      let hashNote = "no .sha256 recorded";
      if (existsSync(sidecar)) {
        const recorded = readFileSync(sidecar, "utf8").trim().split(/\s+/)[0];
        if (sha256OfFile(archive.path) === recorded) {
          hashNote = "sha256 matches";
        } else {
          hashNote = "SHA256 MISMATCH — the file has changed since it was written";
          allGood = false;
        }
      }
      log("INFO", `OK  ${archive.name} — ${trailer.rowCount} rows, ${trailer.tableCount} tables, ${hashNote}.`);
    } catch (error) {
      allGood = false;
      log("ERROR", `BAD ${archive.name} — ${error instanceof Error ? error.message : error}`);
    }
  }
  return allGood;
}

async function main() {
  if (!ERP_URL || !ERP_JOB_SECRET) {
    log("ERROR", "ERP_URL and ERP_JOB_SECRET must be set (in backup.env or the environment).");
    process.exitCode = 1;
    return;
  }

  if (VERIFY_ONLY) {
    process.exitCode = (await verifyOnly()) ? 0 : 1;
    return;
  }

  mkdirSync(BACKUP_DIR, { recursive: true });

  const month = istMonthStamp();
  if (IF_DUE && listArchives(BACKUP_DIR).some((archive) => archive.month === month)) {
    log("INFO", `${month} already has a verified backup; nothing to do.`);
    return;
  }

  const fileName = `manthan-backup-${istDateStamp()}.ndjson.gz`;
  const finalPath = join(BACKUP_DIR, fileName);
  const partPath = `${finalPath}.part`;

  log("INFO", `Backing up ${ERP_URL} to ${finalPath}`);
  rmSync(partPath, { force: true });

  let size;
  try {
    size = await download(partPath);
  } catch (error) {
    rmSync(partPath, { force: true });
    log("ERROR", `Download failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }
  log("INFO", `Downloaded ${humanBytes(size)}. Verifying...`);

  let verified;
  try {
    verified = await verifyArchive(partPath);
  } catch (error) {
    // The unverified download is kept, but under the .part name — never in the
    // folder under a name that would pass for a good backup.
    log("ERROR", `Verification failed: ${error instanceof Error ? error.message : error}`);
    log("ERROR", `The unverified download is at ${partPath}. No backup was taken for ${month}.`);
    process.exitCode = 1;
    return;
  }

  renameSync(partPath, finalPath);
  const hash = sha256OfFile(finalPath);
  writeFileSync(`${finalPath}.sha256`, `${hash}  ${fileName}\n`);
  writeFileSync(
    finalPath.replace(/\.ndjson\.gz$/, ".manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: verified.header.generatedAt,
        migration: verified.header.migration,
        trailer: verified.trailer,
        files: verified.manifest,
      },
      null,
      2,
    )}\n`,
  );

  log(
    "INFO",
    `Verified: ${verified.trailer.rowCount} rows across ${verified.trailer.tableCount} tables, ` +
      `${verified.manifest?.fileCount ?? 0} uploaded file(s) inventoried.`,
  );

  if (WITH_FILES) {
    log("INFO", "Pulling uploaded files...");
    const result = await pullFiles(verified.manifest, join(BACKUP_DIR, "files"));
    log("INFO", `Files: ${result.fetched} fetched, ${result.skipped} already held.`);
    if (result.missing.length) {
      log("WARN", `${result.missing.length} file(s) are referenced by a row but missing from storage:`);
      for (const path of result.missing.slice(0, 20)) log("WARN", `  missing: ${path}`);
    }
    if (result.failed.length) {
      log("ERROR", `${result.failed.length} file(s) could not be fetched:`);
      for (const note of result.failed.slice(0, 20)) log("ERROR", `  failed: ${note}`);
      process.exitCode = 1;
    }
  } else {
    log("INFO", "Uploaded files were inventoried but not copied. Run with --with-files to pull the documents too.");
  }

  prune(BACKUP_DIR);
  log("INFO", `Done. ${fileName} (${humanBytes(size)}, sha256 ${hash.slice(0, 16)}...)`);
}

main().catch((error) => {
  log("ERROR", error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
