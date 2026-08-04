/**
 * Seeds the foundational rows the application cannot start without:
 * institute profile, global configuration, communication config, late-fee
 * slabs, the three predefined roles, an initial Admin account, the document
 * checklist, the current academic year and a first T&C version.
 *
 * Safe to re-run — every write is an upsert.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";
import { SYSTEM_ROLE_DEFINITIONS, SYSTEM_ROLES } from "../src/lib/permissions";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const DOCUMENT_CHECKLIST = [
  { code: "PHOTO", label: "Passport-size photograph", isRequired: true, sortOrder: 1 },
  { code: "BIRTH_CERTIFICATE", label: "Birth certificate", isRequired: true, sortOrder: 2 },
  { code: "PREVIOUS_MARKSHEET", label: "Previous marksheet", isRequired: true, sortOrder: 3 },
  { code: "TRANSFER_CERTIFICATE", label: "Transfer certificate", isRequired: false, sortOrder: 4 },
  { code: "ADDRESS_PROOF", label: "Address proof", isRequired: true, sortOrder: 5 },
  { code: "ID_PROOF", label: "Aadhaar / national ID", isRequired: true, sortOrder: 6 },
];

/** Spec 3.2 example slabs — Admin can edit these in Institute Setup. */
const LATE_FEE_SLABS = [
  { minDaysOverdue: 1, maxDaysOverdue: 7, amountPaise: 10_000 },
  { minDaysOverdue: 8, maxDaysOverdue: 15, amountPaise: 25_000 },
  { minDaysOverdue: 16, maxDaysOverdue: 30, amountPaise: 50_000 },
  { minDaysOverdue: 31, maxDaysOverdue: null, amountPaise: 100_000 },
];

/**
 * The admission form and the fee receipt carry different terms. Receipt terms
 * are kept short deliberately — two copies share one sheet, so there is limited
 * room at the foot of each.
 */
const DEFAULT_ADMISSION_TERMS = `
<h3>Admission Terms</h3>
<ol>
  <li>Admission is granted on the basis of the information declared in this form. Any particular later found to be false or suppressed renders the admission liable to cancellation without refund.</li>
  <li>Admission is provisional until the registration fee is settled in full and all required documents have been submitted and verified.</li>
  <li>Original documents submitted for verification are returned once verification is complete; the institute retains attested copies.</li>
  <li>Fees once paid are non-refundable and non-transferable except as provided by institute policy.</li>
  <li>Scholarships and discounts, where granted, apply to the first year of the course only.</li>
  <li>The institute reserves the right to revise fees for subsequent academic years.</li>
  <li>The student agrees to abide by the rules of conduct, attendance and discipline in force from time to time.</li>
  <li>All disputes are subject to the jurisdiction of the courts where the institute is registered.</li>
</ol>
`.trim();

const DEFAULT_RECEIPT_TERMS = `
<h3>Receipt Terms</h3>
<ol>
  <li>This receipt is valid subject to realisation of the cheque or electronic transfer.</li>
  <li>Fees once paid are non-refundable and non-transferable except as provided by institute policy.</li>
  <li>Every installment must be paid on or before its due date. Late payment attracts a late fee as per the institute's published slab.</li>
  <li>Retain this receipt as proof of payment. Duplicates are issued at the institute's discretion.</li>
</ol>
`.trim();

function academicYearBounds(now = new Date()) {
  // Indian academic year runs June–May.
  const startYear = now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    name: `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    startDate: new Date(startYear, 5, 1),
    endDate: new Date(startYear + 1, 4, 31),
  };
}

async function main() {
  console.log("Seeding…");

  await prisma.institute.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      name: "Manthan Institute of Technology",
      addressLine1: "123 Education Road",
      city: "Ahmedabad",
      state: "Gujarat",
      pincode: "380001",
      contactEmail: "office@manthan.edu.in",
      contactPhone: "+91 79 1234 5678",
      registrationNo: "REG/2019/0042",
      affiliationNo: "AFF/GTU/2019/117",
    },
  });

  await prisma.instituteConfig.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });

  await prisma.communicationConfig.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, emailProvider: "mock", whatsappProvider: "mock" },
  });

  if ((await prisma.lateFeeSlab.count()) === 0) {
    await prisma.lateFeeSlab.createMany({ data: LATE_FEE_SLABS });
  }

  for (const doc of DOCUMENT_CHECKLIST) {
    await prisma.documentRequirement.upsert({
      where: { code: doc.code },
      update: { label: doc.label, sortOrder: doc.sortOrder },
      create: doc,
    });
  }

  const year = academicYearBounds();
  await prisma.academicYear.upsert({
    where: { name: year.name },
    update: {},
    create: { ...year, isCurrent: true },
  });

  for (const role of SYSTEM_ROLE_DEFINITIONS) {
    await prisma.role.upsert({
      where: { name: role.name },
      // Permissions of system roles are kept in sync with the catalogue so a
      // newly added permission reaches Admin without a manual edit.
      update: { permissions: role.permissions, description: role.description, isSystem: true },
      create: { name: role.name, description: role.description, isSystem: true, permissions: role.permissions },
    });
  }

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: SYSTEM_ROLES.ADMIN } });
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@institute.test";
  // The convenience fallback is fine on a local database, but it is published
  // in this repository — seeding a reachable deployment with it would leave the
  // Admin account open to whoever signs in first. `mustResetPassword` only
  // protects the account after someone has already got in.
  if (process.env.NODE_ENV === "production" && !process.env.SEED_ADMIN_PASSWORD) {
    throw new Error(
      "Refusing to seed a production database with the default admin password. " +
        "Set SEED_ADMIN_PASSWORD (and SEED_ADMIN_EMAIL) before running the seed.",
    );
  }
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "Admin@12345";

  await prisma.user.upsert({
    where: { email: adminEmail },
    update: { roleId: adminRole.id, status: "ACTIVE" },
    create: {
      name: "System Administrator",
      employeeId: "EMP0001",
      email: adminEmail,
      passwordHash: await bcrypt.hash(adminPassword, 12),
      roleId: adminRole.id,
      // First login forces a password change (spec 8.2).
      mustResetPassword: true,
    },
  });

  for (const [document, title, content] of [
    ["ADMISSION", "Admission Terms and Conditions", DEFAULT_ADMISSION_TERMS],
    ["RECEIPT", "Receipt Terms and Conditions", DEFAULT_RECEIPT_TERMS],
  ] as const) {
    if ((await prisma.termsVersion.count({ where: { document } })) === 0) {
      await prisma.termsVersion.create({
        data: { document, version: 1, title, content, effectiveFrom: new Date() },
      });
    }
  }

  console.log(`Seed complete. Sign in as ${adminEmail}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
