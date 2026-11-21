import "server-only";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { Client } from "pg";
import { env } from "@/lib/env";
import { buildFileManifest } from "@/lib/backup/manifest";
import { listDataTables, quoteIdent, quoteTable, resolveTableOrder } from "@/lib/backup/tables";

/**
 * A full, consistent snapshot of the database, as a gzipped NDJSON stream.
 *
 * ## Why this shape
 *
 * The office PC pulls this over HTTPS and writes it to disk, so the archive has
 * to be something a plain Node script with no dependencies can read back, and
 * something that can be produced without ever holding the whole database in
 * memory. One JSON object per line, gzipped, satisfies both: the agent can
 * stream it to a file, and the restore script can replay it line by line.
 *
 * ## Consistency
 *
 * Everything happens inside one `REPEATABLE READ READ ONLY` transaction, so
 * every table is read as it stood at the same instant. Without that, a payment
 * written between dumping `Installment` and dumping `Payment` would produce an
 * archive whose foreign keys do not line up — a backup that cannot be restored,
 * discovered on the worst possible day.
 *
 * Rows come back through a server-side cursor rather than one big `SELECT`,
 * because the `pg` driver buffers a whole result set in memory and a serverless
 * function has little of it. `DECLARE`/`FETCH`/`CLOSE` all sit inside the one
 * transaction, which is also what keeps this safe through Neon's pooler.
 *
 * ## Fidelity
 *
 * Rows are serialised by Postgres itself with `to_jsonb(t)`, not by hand and
 * not through Prisma. Dates, enums, nulls and `Json` columns therefore come out
 * exactly as the database holds them, and the restore reverses it with
 * `jsonb_populate_record` against the same row type — no column list to keep in
 * step, and no type that quietly round-trips wrong.
 *
 * ## Completeness
 *
 * The last line is a trailer carrying the row count for every table. It is
 * written only after every table has been read, so an archive that was cut
 * short — a timeout, a dropped connection, a full disk — has no trailer and is
 * rejected by the agent rather than kept as if it were good. A backup that is
 * silently half a backup is worse than none, because it is trusted.
 */

/** Rows per `FETCH`. Big enough to be few round trips, small enough to hold. */
const FETCH_BATCH = 1_000;

export const BACKUP_FORMAT = "manthan-erp-backup";
export const BACKUP_FORMAT_VERSION = 1;

/** Latest migration applied to this database, recorded so a restore can check it. */
async function latestMigration(client: Client): Promise<string | null> {
  try {
    const { rows } = await client.query<{ migration_name: string }>(
      `SELECT migration_name
         FROM public._prisma_migrations
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT 1`,
    );
    return rows[0]?.migration_name ?? null;
  } catch {
    // A database that has never been migrated still deserves to be backed up.
    return null;
  }
}

/**
 * Yields the archive line by line, as text. Each line is one JSON object:
 *
 *   `{"header":{...}}`        once, first
 *   `{"table":"Student"}`     starts a table's rows
 *   `{"row":{...}}`           one database row
 *   `{"manifest":{...}}`      the uploaded-file inventory
 *   `{"trailer":{...}}`       once, last — absent if the dump did not finish
 */
async function* archiveLines(): AsyncGenerator<string> {
  const client = new Client({ connectionString: env.databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const tables = await listDataTables(client);
    const { order, cyclic } = await resolveTableOrder(client, tables);

    yield `${JSON.stringify({
      header: {
        format: BACKUP_FORMAT,
        formatVersion: BACKUP_FORMAT_VERSION,
        generatedAt: new Date().toISOString(),
        migration: await latestMigration(client),
        // The order rows must be reinserted in for foreign keys to hold.
        tableOrder: order,
        // Expected empty. If a future migration introduces a reference cycle,
        // the restore has to break it rather than insert straight through.
        cyclicTables: cyclic,
      },
    })}\n`;

    const counts: Record<string, number> = {};

    for (const name of order) {
      const table = tables.find((candidate) => candidate.name === name);
      if (!table) continue;

      yield `${JSON.stringify({ table: name })}\n`;
      counts[name] = 0;

      const cursor = `backup_${name.replace(/[^A-Za-z0-9_]/g, "_")}`;
      await client.query(
        `DECLARE ${quoteIdent(cursor)} NO SCROLL CURSOR FOR
           SELECT to_jsonb(t) AS row FROM ${quoteTable(table)} t`,
      );

      try {
        for (;;) {
          const { rows } = await client.query<{ row: unknown }>(
            `FETCH ${FETCH_BATCH} FROM ${quoteIdent(cursor)}`,
          );
          if (rows.length === 0) break;
          for (const { row } of rows) {
            yield `${JSON.stringify({ row })}\n`;
          }
          counts[name] += rows.length;
        }
      } finally {
        await client.query(`CLOSE ${quoteIdent(cursor)}`).catch(() => {
          // The transaction is about to end, which closes it anyway.
        });
      }
    }

    const manifest = await buildFileManifest(client);
    yield `${JSON.stringify({ manifest })}\n`;

    // Only now, with every table read and the manifest built, is the archive
    // allowed to claim it is complete.
    yield `${JSON.stringify({
      trailer: {
        complete: true,
        finishedAt: new Date().toISOString(),
        tableCount: order.length,
        rowCount: Object.values(counts).reduce((total, n) => total + n, 0),
        counts,
        fileCount: manifest.fileCount,
      },
    })}\n`;

    await client.query("COMMIT");
  } finally {
    await client.end().catch(() => {
      // Nothing useful to do if the socket is already gone.
    });
  }
}

/** A suggested archive filename, e.g. `manthan-backup-2026-11.ndjson.gz`. */
export function archiveFileName(now: Date = new Date()): string {
  const stamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return `manthan-backup-${stamp}.ndjson.gz`;
}

/**
 * The archive as a web stream, ready to be the body of a `Response`.
 *
 * If the dump throws part-way the stream errors, the HTTP response ends short,
 * and the agent sees an archive with no trailer — which it refuses. That is the
 * intended failure mode: loud and incomplete beats quiet and wrong.
 */
export function backupStream(): ReadableStream<Uint8Array> {
  const gzip = createGzip({ level: 9 });
  const source = Readable.from(archiveLines(), { objectMode: false });

  source.on("error", (error) => gzip.destroy(error));
  source.pipe(gzip);

  return Readable.toWeb(gzip) as ReadableStream<Uint8Array>;
}
