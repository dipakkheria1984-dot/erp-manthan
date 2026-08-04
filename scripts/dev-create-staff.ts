/**
 * Dev helper: create a staff account with a known password for a given role, so
 * role-based access can be exercised without going through the temporary
 * password flow.
 *
 * Usage: npx tsx scripts/dev-create-staff.ts Registrar registrar@institute.test
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const [roleName, email] = process.argv.slice(2);
  if (!roleName || !email) throw new Error("Usage: dev-create-staff.ts <RoleName> <email>");

  // The password below is published in this repository, and the account is
  // created with `mustResetPassword: false` — pointed at a live database this
  // would be a standing back door, not a test fixture.
  if (process.env.NODE_ENV === "production") {
    throw new Error("dev-create-staff.ts is a development helper and will not run against production.");
  }

  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  const password = "Staff@12345";

  const user = await prisma.user.upsert({
    where: { email },
    update: { roleId: role.id, status: "ACTIVE", mustResetPassword: false },
    create: {
      name: `${roleName} User`,
      employeeId: `EMP-${roleName.toUpperCase().slice(0, 4)}-1`,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      roleId: role.id,
      mustResetPassword: false,
    },
  });

  console.log(`${user.email} ready as ${roleName} with password ${password}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
