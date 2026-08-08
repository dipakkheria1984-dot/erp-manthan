import "server-only";
import { prisma, type Db } from "@/lib/db";

export const SEQ = {
  RECEIPT: "receipt",
  APPLICATION: "application",
} as const;

/**
 * Atomically claim the next value of a counter.
 *
 * Postgres serialises the `UPDATE ... RETURNING` on the row, so two concurrent
 * receipt writes can never be handed the same number. Cancelled receipts keep
 * their number (spec 3.4) — nothing is ever handed back to the pool.
 */
export async function nextSequenceValue(key: string, db: Db = prisma): Promise<number> {
  const rows = await db.$queryRaw<{ nextValue: number }[]>`
    INSERT INTO "Sequence" ("key", "nextValue", "updatedAt")
    VALUES (${key}, 2, NOW())
    ON CONFLICT ("key") DO UPDATE
      SET "nextValue" = "Sequence"."nextValue" + 1,
          "updatedAt" = NOW()
    RETURNING "nextValue" - 1 AS "nextValue"
  `;
  return rows[0].nextValue;
}

export function formatSequence(prefix: string, value: number, padding: number): string {
  return `${prefix}${String(value).padStart(padding, "0")}`;
}

/**
 * Claim the next LF No. (spec 1.4 step 8). Lives on InstituteConfig rather than
 * the Sequence table because Admin can reset the start point in Institute Setup.
 *
 * The counter is a starting point, not the whole story: LF numbers also arrive
 * by hand — typed in at approval, or carried over by a bulk import from the old
 * system — so the next value in sequence is not necessarily free. The statement
 * skips ahead to the first number nothing holds and claims that, which is what
 * keeps a migration from aborting on the unique index part-way through.
 *
 * `reserved` covers numbers that are spoken for but not yet written: the
 * explicit LF Nos further down an import file, claimed row by row after this
 * one.
 *
 * Postgres serialises the UPDATE on the config row, so two concurrent
 * approvals can never be handed the same number.
 */
export async function nextLfNo(db: Db = prisma, reserved: readonly number[] = []): Promise<number> {
  const rows = await db.$queryRaw<{ lfNo: number }[]>`
    WITH taken AS (
      SELECT "lfNo" AS n FROM "Application" WHERE "lfNo" IS NOT NULL
      UNION
      SELECT "lfNo" AS n FROM "Student"
      UNION
      SELECT unnest(${reserved}::int[]) AS n
    )
    UPDATE "InstituteConfig" c
    SET "lfNoNext" = (
          -- The first free number at or above the counter is either the counter
          -- itself or one past some number already in use.
          SELECT MIN(candidate.n)
          FROM (
            SELECT c."lfNoNext" AS n
            UNION ALL
            SELECT t.n + 1 AS n FROM taken t WHERE t.n >= c."lfNoNext"
          ) candidate
          WHERE NOT EXISTS (SELECT 1 FROM taken t WHERE t.n = candidate.n)
        ) + 1,
        "updatedAt" = NOW()
    WHERE c."id" = 1
    RETURNING c."lfNoNext" - 1 AS "lfNo"
  `;
  if (!rows.length) throw new Error("Institute configuration has not been initialised.");
  return rows[0].lfNo;
}

/**
 * Claim `count` LF Nos at once, returned in ascending order.
 *
 * A bulk import needs a number for every row it is about to write. Asking
 * `nextLfNo` once per row is a database round trip per student, and on a hosted
 * database those add up until the whole import exceeds its transaction budget
 * and rolls back — so the same skip-what-is-taken rule is applied to a whole
 * block in a single statement.
 *
 * `FOR UPDATE` on the config row makes this serialise against `nextLfNo` and
 * against another import running at the same time: the second one waits, then
 * reads the counter the first left behind rather than the one it started with.
 */
export async function nextLfNoBlock(
  db: Db,
  count: number,
  reserved: readonly number[] = [],
): Promise<number[]> {
  if (count < 1) return [];

  const rows = await db.$queryRaw<{ lfNo: number }[]>`
    WITH taken AS (
      SELECT "lfNo" AS n FROM "Application" WHERE "lfNo" IS NOT NULL
      UNION
      SELECT "lfNo" AS n FROM "Student"
      UNION
      SELECT unnest(${reserved}::int[]) AS n
    ),
    start AS (
      SELECT "lfNoNext" AS n FROM "InstituteConfig" WHERE "id" = 1 FOR UPDATE
    ),
    free AS (
      -- Widening the range by the count of taken numbers at or above the
      -- counter guarantees at least that many survive the exclusion below.
      SELECT g.n
      FROM start s
      CROSS JOIN generate_series(
        s.n,
        s.n + ${count}::int + (SELECT count(*) FROM taken t WHERE t.n >= s.n)::int
      ) AS g(n)
      WHERE NOT EXISTS (SELECT 1 FROM taken t WHERE t.n = g.n)
      ORDER BY g.n
      LIMIT ${count}::int
    ),
    bumped AS (
      UPDATE "InstituteConfig" c
      SET "lfNoNext" = (SELECT MAX(n) FROM free) + 1,
          "updatedAt" = NOW()
      WHERE c."id" = 1 AND (SELECT count(*) FROM free) = ${count}::int
      RETURNING c."id"
    )
    SELECT n::int AS "lfNo" FROM free ORDER BY n
  `;

  if (rows.length !== count) {
    throw new Error("Institute configuration has not been initialised.");
  }
  return rows.map((row) => row.lfNo);
}

export function formatStudentCode(prefix: string, lfNo: number, lfNoLength: number): string {
  return `${prefix}${String(lfNo).padStart(lfNoLength, "0")}`;
}
