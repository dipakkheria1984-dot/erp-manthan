/**
 * Restores a monthly backup archive into a PostgreSQL database.
 *
 *   npm run backup:restore -- backup-agent/archives/manthan-backup-2026-11-01.ndjson.gz
 *
 * This is the half of a backup that decides whether the other half was worth
 * taking. Run it at least once, against a scratch database, before trusting
 * any of this — see backup-agent/README.md, "Practise the restore".
 *
 * Options:
 *   --into <url>          target database; defaults to RESTORE_DATABASE_URL,
 *                         then DATABASE_URL
 *   --force               wipe the target first. Required whenever the target
 *                         already holds rows.
 *   --allow-production    permit a restore while NODE_ENV=production
 *   --ignore-migration    proceed even if the target's schema version differs
 *                         from the archive's
 *   --dry-run             validate the archive and report, touching nothing
 *
 * Order of operations is deliberate: the archive is fully validated *before*
 * the target is touched, so a bad archive can never leave a half-emptied
 * database behind.
 */
import "dotenv/config";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { Client } from "pg";

const BACKUP_FORMAT = "manthan-erp-backup";
/** Rows per INSERT. Large enough to be few round trips, small enough to parse. */
const INSERT_BATCH = 500;

type Header = {
  format: string;
  formatVersion: number;
  generatedAt: string;
  migration: string | null;
  tableOrder: string[];
  cyclicTables: string[];
};

type Trailer = {
  complete: boolean;
  tableCount: number;
  rowCount: number;
  counts: Record<string, number>;
  fileCount: number;
};

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/* ------------------------------------------------------------- arguments -- */

const argv = process.argv.slice(2);

/** Flags that take a value, so the value is not mistaken for the archive path. */
const VALUED_FLAGS = new Set(["--into"]);

const flags = new Set<string>();
const values = new Map<string, string>();
const positional: string[] = [];

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (!arg.startsWith("--")) {
    positional.push(arg);
  } else if (VALUED_FLAGS.has(arg)) {
    values.set(arg, argv[index + 1] ?? "");
    index += 1;
  } else {
    flags.add(arg);
  }
}

const archivePath = positional[0];
const valueOf = (flag: string): string | undefined => values.get(flag) || undefined;

const targetUrl = valueOf("--into") ?? process.env.RESTORE_DATABASE_URL ?? process.env.DATABASE_URL;
const force = flags.has("--force");
const dryRun = flags.has("--dry-run");
const allowProduction = flags.has("--allow-production");
const ignoreMigration = flags.has("--ignore-migration");

/* ----------------------------------------------------------------- read -- */

type Archive = {
  header: Header;
  trailer: Trailer;
  /** Rows per table, in the order the archive listed them. */
  rows: Map<string, unknown[]>;
  manifest: { fileCount?: number; entries?: Array<{ storagePath: string }> } | null;
};

/**
 * Reads the whole archive into memory, checking it as it goes.
 *
 * Holding it in memory is a deliberate trade. An institute-sized database is a
 * few tens of megabytes of JSON, and reading it through first means the restore
 * either happens completely or does not begin — far better than streaming
 * straight into a database that has already been emptied.
 */
async function readArchive(path: string): Promise<Archive> {
  let header: Header | null = null;
  let trailer: Trailer | null = null;
  let manifest: Archive["manifest"] = null;
  let currentTable: string | null = null;
  const rows = new Map<string, unknown[]>();
  let lineNo = 0;

  const lines = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    lineNo += 1;
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`Archive is corrupt: line ${lineNo} is not valid JSON.`);
    }

    if (parsed.header) {
      header = parsed.header as Header;
      if (header.format !== BACKUP_FORMAT) {
        throw new Error(`Not a Manthan backup: format is "${header.format}".`);
      }
      if (header.formatVersion !== 1) {
        throw new Error(
          `Archive format version ${header.formatVersion} is newer than this script understands (1).`,
        );
      }
      continue;
    }
    if (typeof parsed.table === "string") {
      currentTable = parsed.table;
      if (!rows.has(currentTable)) rows.set(currentTable, []);
      continue;
    }
    if (parsed.row) {
      if (!currentTable) throw new Error(`Archive is corrupt: a row at line ${lineNo} precedes any table.`);
      rows.get(currentTable)!.push(parsed.row);
      continue;
    }
    if (parsed.manifest) {
      manifest = parsed.manifest as Archive["manifest"];
      continue;
    }
    if (parsed.trailer) {
      trailer = parsed.trailer as Trailer;
    }
  }

  if (!header) throw new Error("Archive has no header — it is not a Manthan backup.");
  if (!trailer?.complete) {
    throw new Error("Archive has no completion trailer: the dump that produced it did not finish. Do not use it.");
  }

  for (const [table, expected] of Object.entries(trailer.counts ?? {})) {
    const actual = rows.get(table)?.length ?? 0;
    if (actual !== expected) {
      throw new Error(`Archive is short: ${table} holds ${actual} rows, the trailer claims ${expected}.`);
    }
  }

  return { header, trailer, rows, manifest };
}

/* -------------------------------------------------------------- restore -- */

/** Tables that exist in the target database right now. */
async function existingTables(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_class c
      WHERE c.relkind = 'r'
        AND c.relispartition = false
        AND c.relnamespace::regnamespace::text = 'public'
        AND c.relname <> '_prisma_migrations'`,
  );
  return new Set(rows.map((row) => row.name));
}

async function latestMigration(client: Client): Promise<string | null> {
  try {
    const { rows } = await client.query<{ migration_name: string }>(
      `SELECT migration_name FROM public._prisma_migrations
        WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
    );
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

async function totalRows(client: Client, tables: string[]): Promise<number> {
  let total = 0;
  for (const table of tables) {
    const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.${quoteIdent(table)}`);
    total += Number(rows[0]?.n ?? 0);
  }
  return total;
}

/**
 * Puts every identity sequence back above the ids that were just inserted.
 *
 * Rows carry their original primary keys, which bypasses the sequence entirely.
 * Left alone, the next insert through the app would reuse id 1 and fail on the
 * unique constraint — a restored database that reads correctly and refuses
 * every new write.
 */
async function resyncSequences(client: Client, tables: string[]): Promise<number> {
  let resynced = 0;
  for (const table of tables) {
    const { rows } = await client.query<{ column_name: string; seq: string | null }>(
      `SELECT column_name,
              pg_get_serial_sequence('public.' || quote_ident($1), column_name) AS seq
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    for (const { column_name, seq } of rows) {
      if (!seq) continue;
      await client.query(
        `SELECT setval($1, COALESCE((SELECT MAX(${quoteIdent(column_name)}) FROM public.${quoteIdent(table)}), 0) + 1, false)`,
        [seq],
      );
      resynced += 1;
    }
  }
  return resynced;
}

async function main() {
  if (!archivePath) {
    throw new Error("Pass the archive to restore, e.g. backup-agent/archives/manthan-backup-2026-11-01.ndjson.gz");
  }
  if (!targetUrl) {
    throw new Error("No target database. Set DATABASE_URL, or pass --into <connection string>.");
  }
  if (process.env.NODE_ENV === "production" && !allowProduction) {
    throw new Error("NODE_ENV=production. Re-run with --allow-production if you really mean to restore over it.");
  }

  console.log(`Reading ${archivePath}`);
  const archive = await readArchive(archivePath);
  console.log(
    `Archive is complete: ${archive.trailer.rowCount} rows across ${archive.trailer.tableCount} tables, ` +
      `taken ${archive.header.generatedAt}, schema ${archive.header.migration ?? "unknown"}, ` +
      `${archive.manifest?.fileCount ?? 0} uploaded file(s) inventoried.`,
  );

  if (archive.header.cyclicTables?.length) {
    throw new Error(
      `This archive reports tables in a foreign-key cycle (${archive.header.cyclicTables.join(", ")}), ` +
        `which a straight ordered insert cannot satisfy. Restore needs to be extended before this archive can be used.`,
    );
  }

  if (dryRun) {
    console.log("\n--dry-run: the archive is valid and restorable. Nothing was written.");
    for (const table of archive.header.tableOrder) {
      console.log(`  ${table.padEnd(26)} ${archive.rows.get(table)?.length ?? 0}`);
    }
    return;
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();

  try {
    const { rows: who } = await client.query<{ db: string; host: string }>(
      `SELECT current_database() AS db, inet_server_addr()::text AS host`,
    );
    console.log(`\nTarget: database "${who[0]?.db}" at ${who[0]?.host ?? "local socket"}`);

    const present = await existingTables(client);
    const restorable = archive.header.tableOrder.filter((table) => present.has(table));
    const missing = archive.header.tableOrder.filter((table) => !present.has(table));
    if (missing.length) {
      console.warn(
        `\nWARNING: the target has no table for ${missing.join(", ")}. ` +
          `Run \`npm run db:deploy\` against it first, or those rows will be skipped.`,
      );
    }

    const targetMigration = await latestMigration(client);
    if (targetMigration !== archive.header.migration) {
      const detail = `archive was taken at "${archive.header.migration ?? "unknown"}", target is at "${targetMigration ?? "unknown"}"`;
      if (!ignoreMigration) {
        throw new Error(
          `Schema version mismatch: ${detail}. Bring the target to the same migration with ` +
            `\`npm run db:deploy\`, or pass --ignore-migration if you have checked the columns line up.`,
        );
      }
      console.warn(`\nWARNING: ${detail}. Continuing because --ignore-migration was given.`);
    }

    const existingRowCount = await totalRows(client, [...present]);
    if (existingRowCount > 0 && !force) {
      throw new Error(
        `The target already holds ${existingRowCount} rows. Pass --force to erase it and restore over the top.`,
      );
    }

    await client.query("BEGIN");

    if (existingRowCount > 0) {
      console.log(`Erasing ${existingRowCount} existing rows...`);
      const list = restorable.map((table) => `public.${quoteIdent(table)}`).join(", ");
      await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }

    let inserted = 0;
    for (const table of restorable) {
      const tableRows = archive.rows.get(table) ?? [];
      if (tableRows.length === 0) continue;

      for (let offset = 0; offset < tableRows.length; offset += INSERT_BATCH) {
        const batch = tableRows.slice(offset, offset + INSERT_BATCH);
        // `jsonb_populate_recordset` casts each key against the table's own row
        // type, so dates, enums and json columns land exactly as dumped and
        // there is no column list here to drift out of step with the schema.
        await client.query(
          `INSERT INTO public.${quoteIdent(table)}
             SELECT * FROM jsonb_populate_recordset(NULL::public.${quoteIdent(table)}, $1::jsonb)`,
          [JSON.stringify(batch)],
        );
        inserted += batch.length;
      }
      console.log(`  ${table.padEnd(26)} ${tableRows.length}`);
    }

    const resynced = await resyncSequences(client, restorable);
    await client.query("COMMIT");

    const finalCount = await totalRows(client, restorable);
    console.log(`\nRestored ${inserted} rows into ${restorable.length} tables; ${resynced} sequence(s) resynced.`);
    console.log(`The target now holds ${finalCount} rows.`);

    if (archive.manifest?.entries?.length) {
      console.log(
        `\n${archive.manifest.entries.length} uploaded file reference(s) were restored. The files themselves are ` +
          `not in this archive — restore them from backup-agent/archives/files (pulled with --with-files), ` +
          `or expect document downloads to fail until the blob store is back.`,
      );
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      // Nothing to roll back if the failure was the connection itself.
    });
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
