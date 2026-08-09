import "server-only";
import { cache } from "react";
import { prisma, type Db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { readStoredFile } from "@/lib/storage";
import type { InstituteConfig, Institute, CommunicationConfig } from "@/generated/prisma/client";

/**
 * Institute-wide configuration accessors (spec 9.2).
 *
 * `scholarshipAutoApprovePercent` is a hidden value: it must never be returned
 * to a non-admin client. Use `getPublicConfig` for anything that reaches
 * Registrar/Accountant screens, and `getConfig` only inside server-side
 * business logic or Admin-only pages.
 */

/**
 * Memoised for the life of one request. A page, the components under it and the
 * helpers they call ask for the configuration independently — the same single
 * row fetched five or six times before anything is rendered, each one a round
 * trip to whichever region the database lives in. `cache` keys on the argument,
 * so a call inside a transaction is still answered by that transaction.
 */
export const getConfig = cache(async function getConfig(db: Db = prisma): Promise<InstituteConfig> {
  const config = await db.instituteConfig.findUnique({ where: { id: 1 } });
  if (!config) {
    throw new AppError("Institute configuration has not been initialised. Run the seed first.");
  }
  return config;
});

export type PublicConfig = Omit<InstituteConfig, "scholarshipAutoApprovePercent">;

/** Config with hidden values stripped — safe for any authenticated staff UI. */
export async function getPublicConfig(db: Db = prisma): Promise<PublicConfig> {
  const { scholarshipAutoApprovePercent: _hidden, ...rest } = await getConfig(db);
  void _hidden;
  return rest;
}

export const getInstitute = cache(async function getInstitute(db: Db = prisma): Promise<Institute> {
  const institute = await db.institute.findUnique({ where: { id: 1 } });
  if (!institute) {
    throw new AppError("Institute profile has not been initialised. Run the seed first.");
  }
  return institute;
});

/**
 * The uploaded logo's bytes, ready to be embedded in a PDF letterhead.
 *
 * Null whenever there is no logo, or the stored file has gone missing — a
 * receipt still has to print if someone empties the upload directory.
 */
export async function getInstituteLogo(institute: Institute): Promise<Buffer | null> {
  if (!institute.logoStoragePath) return null;
  return readStoredFile(institute.logoStoragePath);
}

export async function getCommunicationConfig(db: Db = prisma): Promise<CommunicationConfig> {
  const config = await db.communicationConfig.findUnique({ where: { id: 1 } });
  if (!config) {
    throw new AppError("Communication configuration has not been initialised. Run the seed first.");
  }
  return config;
}

export async function getCurrentAcademicYear(db: Db = prisma) {
  return db.academicYear.findFirst({ where: { isCurrent: true } });
}
