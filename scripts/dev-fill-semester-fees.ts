/**
 * Dev helper: give every semester that still has zero exam/activity fees a
 * sensible default, so downstream fee assignment has something to compute with.
 * Not part of the seed — run it manually when setting up a demo dataset.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const updated = await prisma.semester.updateMany({
    where: { examFeePaise: 0, activityFeePaise: 0 },
    data: { examFeePaise: 300_000, activityFeePaise: 150_000 },
  });
  console.log(`Set default exam/activity fees on ${updated.count} semester(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
