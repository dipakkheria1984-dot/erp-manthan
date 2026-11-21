import "server-only";
import type { Client } from "pg";

/**
 * What is in the database, discovered from the database itself.
 *
 * Nothing here is a hand-written list of tables. A backup whose contents are
 * maintained by hand is the kind that quietly stops covering everything: a
 * migration adds a table, nobody remembers this file, and the gap only shows up
 * on the day it has to be restored. Asking Postgres instead means a new model is
 * in the next backup without anyone doing anything.
 */

export type TableRef = {
  /** Always `public` here, kept explicit so the quoting helpers stay honest. */
  schema: string;
  name: string;
};

/** `"public"."Student"` — safe to interpolate, both halves are quoted. */
export function quoteTable(table: TableRef): string {
  return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
}

/** Quotes one identifier the way Postgres does, doubling any embedded quote. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Every ordinary table holding application data.
 *
 * Views, foreign tables and partitions are excluded (they hold no row of their
 * own to save), as is `_prisma_migrations`: the restore target gets its schema
 * from `prisma migrate deploy`, so carrying the migration history across would
 * either duplicate rows that are already there or, worse, contradict them.
 */
export async function listDataTables(client: Client): Promise<TableRef[]> {
  const { rows } = await client.query<{ schema: string; name: string }>(
    `SELECT c.relnamespace::regnamespace::text AS schema,
            c.relname                          AS name
       FROM pg_class c
      WHERE c.relkind = 'r'
        AND c.relispartition = false
        AND c.relnamespace::regnamespace::text = 'public'
        AND c.relname <> '_prisma_migrations'
      ORDER BY c.relname`,
  );
  return rows;
}

/**
 * Foreign keys between the given tables, as `dependent -> referenced` pairs.
 *
 * Self-references are dropped: a row pointing at its own table says nothing
 * about which table has to be loaded first, and leaving them in would make
 * every self-referencing table look like a cycle.
 */
async function listForeignKeys(
  client: Client,
  tables: TableRef[],
): Promise<Array<{ from: string; to: string }>> {
  const names = tables.map((t) => t.name);
  const { rows } = await client.query<{ from: string; to: string }>(
    `SELECT dep.relname AS from, ref.relname AS to
       FROM pg_constraint k
       JOIN pg_class dep ON dep.oid = k.conrelid
       JOIN pg_class ref ON ref.oid = k.confrelid
      WHERE k.contype = 'f'
        AND dep.relname = ANY($1::text[])
        AND ref.relname = ANY($1::text[])`,
    [names],
  );
  return rows.filter((row) => row.from !== row.to);
}

export type TableOrder = {
  /** Load order: every table appears after the tables it points at. */
  order: string[];
  /**
   * Tables whose foreign keys could not all be satisfied by ordering alone,
   * because they sit in a cycle. Restoring these needs the two-pass path in
   * scripts/restore-backup.ts rather than a plain ordered insert.
   */
  cyclic: string[];
};

/**
 * Orders tables so that a straight sequence of inserts never trips a foreign
 * key — parents before children.
 *
 * Kahn's algorithm, with ties broken alphabetically so the same database always
 * produces the same order and two archives can be diffed. Anything left when no
 * table has zero remaining dependencies is part of a cycle; those are appended
 * and reported, because silently emitting an order that cannot be replayed is
 * exactly the kind of thing that is discovered too late.
 */
export async function resolveTableOrder(
  client: Client,
  tables: TableRef[],
): Promise<TableOrder> {
  const edges = await listForeignKeys(client, tables);
  const names = tables.map((t) => t.name);

  /** For each table, the set of tables that must be loaded before it. */
  const blockedBy = new Map<string, Set<string>>(names.map((name) => [name, new Set<string>()]));
  for (const edge of edges) {
    blockedBy.get(edge.from)?.add(edge.to);
  }

  const order: string[] = [];
  const placed = new Set<string>();

  for (;;) {
    const ready = names
      .filter((name) => !placed.has(name))
      .filter((name) => {
        const blockers = blockedBy.get(name);
        if (!blockers) return true;
        for (const blocker of blockers) {
          if (!placed.has(blocker)) return false;
        }
        return true;
      })
      .sort();

    if (ready.length === 0) break;
    for (const name of ready) {
      order.push(name);
      placed.add(name);
    }
  }

  const cyclic = names.filter((name) => !placed.has(name)).sort();
  return { order: [...order, ...cyclic], cyclic };
}
