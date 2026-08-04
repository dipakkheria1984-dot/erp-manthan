import "server-only";
import { prisma, type Db } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import { rupeesToPaise } from "@/lib/money";
import { startOfDay } from "@/lib/dates";
import { formatStudentCode, nextLfNo } from "@/lib/sequence";
import {
  mapHeaders,
  normaliseHeader,
  parseDate,
  readGrid,
  text,
  type ImportColumn,
  type ImportIssue,
  type RawRow,
} from "@/lib/imports/grid";
import type { Gender, GuardianRelation, StudentStatus } from "@/generated/prisma/client";

export type { ImportColumn, ImportIssue, RawRow };

/**
 * Bulk import of existing student data (spec 1.8).
 *
 * This is a *migration* path, not the admission workflow: rows land directly as
 * enrolled students. Each row still gets a backing Application record (the
 * Student→Application relation is required and unique) marked ENROLLED and
 * annotated as migrated, so the audit trail stays honest about how the student
 * entered the system.
 *
 * The import runs in two passes — parse/validate for preview, then commit —
 * against the same stored file, so what the Admin approves is exactly what is
 * written.
 */

export const IMPORT_COLUMNS: ImportColumn[] = [
  { key: "fullName", header: "Full Name", required: true, help: "Student's full name." },
  { key: "gender", header: "Gender", required: true, help: "Male, Female or Other." },
  { key: "departmentCode", header: "Department Code", required: true, help: "Must match an existing department code." },
  { key: "courseCode", header: "Course Code", required: true, help: "Must belong to that department." },
  { key: "batchCode", header: "Batch Code", required: true, help: "Must belong to that course." },
  { key: "lfNo", header: "LF No", help: "5-digit number. Left blank, the next number in sequence is assigned." },
  { key: "semesterNumber", header: "Semester", help: "Current semester number. Defaults to 1." },
  { key: "status", header: "Status", help: "Active, Passed, Dropped-out or Expelled. Defaults to Active." },
  { key: "enrollmentDate", header: "Enrollment Date", help: "YYYY-MM-DD or DD/MM/YYYY. Defaults to today." },
  { key: "dob", header: "Date of Birth", help: "YYYY-MM-DD or DD/MM/YYYY." },
  { key: "bloodGroup", header: "Blood Group", help: "e.g. O+" },
  { key: "phone", header: "Phone", help: "Used for WhatsApp fee reminders." },
  { key: "email", header: "Email", help: "Used for email fee reminders." },
  { key: "addressLine1", header: "Address Line 1", help: "" },
  { key: "addressLine2", header: "Address Line 2", help: "" },
  { key: "city", header: "City", help: "" },
  { key: "state", header: "State", help: "" },
  { key: "pincode", header: "PIN Code", help: "" },
  { key: "nationalId", header: "National ID", help: "Aadhaar or equivalent. Used for duplicate detection." },
  { key: "previousEnrollmentNo", header: "Previous Enrollment No", help: "Their identifier in the old system." },
  { key: "guardianName", header: "Guardian Name", help: "Recorded as the primary contact." },
  { key: "guardianRelation", header: "Guardian Relation", help: "Father, Mother or Guardian. Defaults to Guardian." },
  { key: "guardianPhone", header: "Guardian Phone", help: "" },
  { key: "guardianEmail", header: "Guardian Email", help: "" },
  { key: "guardianOccupation", header: "Guardian Occupation", help: "" },
  {
    key: "outstandingAmount",
    header: "Outstanding Amount",
    help:
      "Opening balance in rupees carried over from the old system. For a student paying in several installments, " +
      "add numbered columns — Outstanding Amount 2, Outstanding Amount 3, and so on — each with its own due date.",
  },
  {
    key: "outstandingDueDate",
    header: "Outstanding Due Date",
    help: "Required when an outstanding amount is given. Must be on or before the batch completion date.",
  },
];

/**
 * A migrated student often arrives mid-way through a payment plan, owing several
 * installments on different dates. Those are carried in as numbered column
 * pairs: `Outstanding Amount` / `Outstanding Due Date` is the first, then
 * `Outstanding Amount 2` / `Outstanding Due Date 2`, and so on.
 *
 * The pairs are discovered from the header row rather than fixed in advance, so
 * a file can carry as many as the institute's installment maximum allows without
 * this list needing to change. A file using only the original single pair keeps
 * working untouched.
 */
export const TEMPLATE_INSTALLMENT_PAIRS = 4;

export function installmentHeaders(seq: number): { amount: string; due: string } {
  return seq === 1
    ? { amount: "Outstanding Amount", due: "Outstanding Due Date" }
    : { amount: `Outstanding Amount ${seq}`, due: `Outstanding Due Date ${seq}` };
}

type InstallmentColumn = { seq: number; amountIndex: number | null; dueIndex: number | null };

/**
 * Locates every `Outstanding Amount[n]` / `Outstanding Due Date[n]` pair in the
 * header row. `repeated` holds the positions of headers reusing a number an
 * earlier column already claimed — hand-extended files often carry several
 * copies of the last pair the template shipped with, and every copy after the
 * first would otherwise be dropped along with the money in it.
 */
function findInstallmentColumns(headerCells: string[]): {
  columns: InstallmentColumn[];
  repeated: number[];
} {
  const bySeq = new Map<number, InstallmentColumn>();
  const repeated: number[] = [];

  headerCells.forEach((cell, index) => {
    const amount = /^outstandingamount(\d*)$/.exec(cell);
    const due = /^outstandingduedate(\d*)$/.exec(cell);
    if (!amount && !due) return;

    const seq = Number((amount ?? due)![1] || "1");
    if (!Number.isInteger(seq) || seq < 1) return;

    const entry = bySeq.get(seq) ?? { seq, amountIndex: null, dueIndex: null };
    // First occurrence wins, matching how the other columns are mapped.
    if (amount) {
      if (entry.amountIndex === null) entry.amountIndex = index;
      else repeated.push(index);
    }
    if (due) {
      if (entry.dueIndex === null) entry.dueIndex = index;
      else repeated.push(index);
    }
    bySeq.set(seq, entry);
  });

  return { columns: [...bySeq.values()].sort((a, b) => a.seq - b.seq), repeated };
}

/** One carried-over installment: an amount owed on a date. */
export type OpeningInstallment = { amountPaise: number; dueDate: Date };

export type PreparedRow = {
  rowNumber: number;
  raw: Record<string, string>;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  /**
   * Best-effort count and total of the opening balance, present even when the
   * row has errors so the preview can still show what was read.
   */
  opening: { count: number; totalPaise: number };
  /** Present only when the row has no errors. */
  resolved?: {
    fullName: string;
    gender: Gender;
    dob: Date | null;
    bloodGroup: string | null;
    phone: string | null;
    email: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    nationalId: string | null;
    previousEnrollmentNo: string | null;
    departmentId: string;
    courseId: string;
    batchId: string;
    semesterId: string;
    status: StudentStatus;
    enrollmentDate: Date;
    lfNo: number | null;
    guardian: {
      name: string;
      relation: GuardianRelation;
      phone: string | null;
      email: string | null;
      occupation: string | null;
    } | null;
    /** Ordered earliest due date first; empty when the student owes nothing. */
    installments: OpeningInstallment[];
  };
};

export type ImportPreview = {
  fileName: string;
  storagePath: string;
  totalRows: number;
  validRows: number;
  rows: PreparedRow[];
  /** File-level problems that stop the whole import. */
  fatal: string[];
};

const GENDERS: Record<string, Gender> = {
  male: "MALE",
  m: "MALE",
  female: "FEMALE",
  f: "FEMALE",
  other: "OTHER",
  o: "OTHER",
};

const STATUSES: Record<string, StudentStatus> = {
  active: "ACTIVE",
  passed: "PASSED",
  droppedout: "DROPPED_OUT",
  dropped: "DROPPED_OUT",
  expelled: "EXPELLED",
};

const RELATIONS: Record<string, GuardianRelation> = {
  father: "FATHER",
  mother: "MOTHER",
  guardian: "GUARDIAN",
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export async function prepareImport(
  storagePath: string,
  fileName: string,
  db: Db = prisma,
): Promise<ImportPreview> {
  const grid = await readGrid(storagePath);
  const fatal: string[] = [];

  if (grid.length === 0) {
    return { fileName, storagePath, totalRows: 0, validRows: 0, rows: [], fatal: ["The file has no rows."] };
  }

  const headerCells = grid[0].map((cell) => normaliseHeader(cell));
  const columnIndex = mapHeaders(grid[0], IMPORT_COLUMNS);

  const missingRequired = IMPORT_COLUMNS.filter((c) => c.required && !columnIndex.has(c.key));
  if (missingRequired.length > 0) {
    fatal.push(`Missing required column(s): ${missingRequired.map((c) => c.header).join(", ")}.`);
  }
  if (columnIndex.size === 0) {
    fatal.push("None of the column headers were recognised. Download the template and use its header row.");
  }
  if (fatal.length > 0) {
    return { fileName, storagePath, totalRows: grid.length - 1, validRows: 0, rows: [], fatal };
  }

  const { columns: installmentColumns, repeated: repeatedInstallmentColumns } =
    findInstallmentColumns(headerCells);

  const rawRows: RawRow[] = grid.slice(1).map((cells, index) => {
    const values: Record<string, string> = {};
    for (const [key, position] of columnIndex) {
      values[key] = (cells[position] ?? "").trim();
    }
    // +2 because the header is row 1 and spreadsheets are 1-indexed.
    return { rowNumber: index + 2, values, cells };
  });

  // A repeated installment header is ignored, and with it whatever it holds —
  // an opening balance quietly imported short. An empty repeat is harmless, so
  // only one carrying data stops the file.
  const carryingData = repeatedInstallmentColumns.filter((index) =>
    rawRows.some((row) => (row.cells[index] ?? "").trim() !== ""),
  );
  if (carryingData.length > 0) {
    const labels = [...new Set(carryingData.map((index) => grid[0][index]?.trim() || headerCells[index]))];
    return {
      fileName,
      storagePath,
      totalRows: rawRows.length,
      validRows: 0,
      rows: [],
      fatal: [
        `These columns repeat a number an earlier column already uses: ${labels.join(", ")}.`,
        "Give every installment pair its own number — Outstanding Amount 5 / Outstanding Due Date 5, then 6, and so on —" +
          " otherwise only the first pair with each number is read and the rest of the opening balance is lost.",
      ],
    };
  }

  const [departments, courses, batches, semesters, config] = await Promise.all([
    db.department.findMany({ select: { id: true, code: true, status: true } }),
    db.course.findMany({ select: { id: true, code: true, departmentId: true } }),
    db.batch.findMany({
      select: {
        id: true,
        code: true,
        courseId: true,
        totalSeats: true,
        completionDate: true,
        status: true,
        _count: { select: { students: true } },
      },
    }),
    db.semester.findMany({ select: { id: true, batchId: true, semesterNumber: true } }),
    getConfig(db),
  ]);

  const departmentByCode = new Map(departments.map((d) => [d.code.toUpperCase(), d]));
  const courseByCode = new Map(courses.map((c) => [c.code.toUpperCase(), c]));
  const batchByCode = new Map(batches.map((b) => [b.code.toUpperCase(), b]));

  // Both tables carry a unique LF No, and an application holds one from the
  // moment it is approved — before its student row exists. Checking only
  // students would let a row through that the write then rejects.
  const [studentLfNos, applicationLfNos] = await Promise.all([
    db.student.findMany({ select: { lfNo: true } }),
    db.application.findMany({ where: { lfNo: { not: null } }, select: { lfNo: true } }),
  ]);
  const existingLfNos = new Set<number>([
    ...studentLfNos.map((s) => s.lfNo),
    ...applicationLfNos.map((a) => a.lfNo!),
  ]);
  const seenLfNos = new Set<number>();
  const seenNationalIds = new Set<string>();
  // Seats must account for rows earlier in this same file, not just the database.
  const seatsTaken = new Map<string, number>(batches.map((b) => [b.id, b._count.students]));

  const rows: PreparedRow[] = [];

  for (const raw of rawRows) {
    const errors: ImportIssue[] = [];
    const warnings: ImportIssue[] = [];
    const v = raw.values;

    const fullName = text(v.fullName);
    if (!fullName) errors.push({ field: "fullName", message: "Full name is required." });

    const genderRaw = (text(v.gender) ?? "").toLowerCase().replace(/[^a-z]/g, "");
    const gender = GENDERS[genderRaw];
    if (!gender) errors.push({ field: "gender", message: `Gender "${v.gender}" is not Male, Female or Other.` });

    const department = departmentByCode.get((text(v.departmentCode) ?? "").toUpperCase());
    if (!department) {
      errors.push({ field: "departmentCode", message: `No department with code "${v.departmentCode}".` });
    }

    const course = courseByCode.get((text(v.courseCode) ?? "").toUpperCase());
    if (!course) {
      errors.push({ field: "courseCode", message: `No course with code "${v.courseCode}".` });
    } else if (department && course.departmentId !== department.id) {
      errors.push({ field: "courseCode", message: `Course ${v.courseCode} does not belong to ${v.departmentCode}.` });
    }

    const batch = batchByCode.get((text(v.batchCode) ?? "").toUpperCase());
    if (!batch) {
      errors.push({ field: "batchCode", message: `No batch with code "${v.batchCode}".` });
    } else if (course && batch.courseId !== course.id) {
      errors.push({ field: "batchCode", message: `Batch ${v.batchCode} does not belong to ${v.courseCode}.` });
    }

    const semesterNumber = text(v.semesterNumber) ? Number(v.semesterNumber) : 1;
    let semesterId: string | undefined;
    if (batch) {
      if (!Number.isInteger(semesterNumber) || semesterNumber < 1) {
        errors.push({ field: "semesterNumber", message: "Semester must be a whole number." });
      } else {
        const semester = semesters.find((s) => s.batchId === batch.id && s.semesterNumber === semesterNumber);
        if (!semester) {
          errors.push({ field: "semesterNumber", message: `Batch ${batch.code} has no semester ${semesterNumber}.` });
        } else {
          semesterId = semester.id;
        }
      }
    }

    const statusRaw = (text(v.status) ?? "active").toLowerCase().replace(/[^a-z]/g, "");
    const status = STATUSES[statusRaw];
    if (!status) errors.push({ field: "status", message: `Status "${v.status}" is not recognised.` });

    const dob = parseDate(v.dob);
    if (dob === "invalid") errors.push({ field: "dob", message: "Date of birth is not a valid date." });

    const enrollment = parseDate(v.enrollmentDate);
    if (enrollment === "invalid") errors.push({ field: "enrollmentDate", message: "Enrollment date is not valid." });
    const enrollmentDate = enrollment && enrollment !== "invalid" ? enrollment : startOfDay(new Date());

    // Seat capacity, counting rows already accepted from this file (spec 5.3).
    if (batch && errors.length === 0) {
      const taken = seatsTaken.get(batch.id) ?? 0;
      if (taken >= batch.totalSeats) {
        errors.push({
          field: "batchCode",
          message: `Batch ${batch.code} is full (${batch.totalSeats} seats). There is no waitlist.`,
        });
      }
    }

    let lfNo: number | null = null;
    const lfRaw = text(v.lfNo);
    if (lfRaw) {
      const parsed = Number(lfRaw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        errors.push({ field: "lfNo", message: "LF No must be a positive whole number." });
      } else if (existingLfNos.has(parsed)) {
        errors.push({ field: "lfNo", message: `LF No ${parsed} is already in use.` });
      } else if (seenLfNos.has(parsed)) {
        errors.push({ field: "lfNo", message: `LF No ${parsed} appears more than once in this file.` });
      } else {
        lfNo = parsed;
      }
    }

    const nationalId = text(v.nationalId);
    if (nationalId) {
      if (seenNationalIds.has(nationalId)) {
        warnings.push({ field: "nationalId", message: "This National ID appears more than once in this file." });
      }
      const existing = await db.student.findFirst({ where: { nationalId }, select: { studentCode: true } });
      if (existing) {
        warnings.push({
          field: "nationalId",
          message: `A student with this National ID already exists (${existing.studentCode}).`,
        });
      }
    }

    if (fullName && dob && dob !== "invalid") {
      const duplicate = await db.student.findFirst({
        where: { fullName: { equals: fullName, mode: "insensitive" }, dob },
        select: { studentCode: true },
      });
      if (duplicate) {
        warnings.push({ message: `Same name and date of birth as existing student ${duplicate.studentCode}.` });
      }
    }

    // A migrated student may owe several installments on different dates, one
    // per numbered column pair. Each is validated on its own so the Admin sees
    // exactly which one is wrong rather than a single vague complaint.
    const installments: OpeningInstallment[] = [];
    let outOfOrder = false;

    for (const column of installmentColumns) {
      const label = installmentHeaders(column.seq);
      const field = column.seq === 1 ? "outstandingAmount" : `outstandingAmount${column.seq}`;
      const amountRaw = column.amountIndex === null ? null : text(raw.cells[column.amountIndex]);
      const dueRaw = column.dueIndex === null ? null : text(raw.cells[column.dueIndex]);

      if (!amountRaw && !dueRaw) continue;

      if (!amountRaw) {
        errors.push({ field, message: `${label.due} has a date but ${label.amount} is empty.` });
        continue;
      }

      const numeric = Number(amountRaw.replace(/,/g, ""));
      if (!Number.isFinite(numeric) || numeric < 0) {
        errors.push({ field, message: `${label.amount} must be a non-negative number.` });
        continue;
      }
      // Exports from the old system often carry a literal 0 for students who
      // owe nothing; that is not an opening balance and needs no due date.
      if (numeric === 0) continue;

      const due = parseDate(dueRaw ?? undefined);
      if (due === "invalid") {
        errors.push({ field, message: `${label.due} is not a valid date.` });
        continue;
      }
      if (!due) {
        errors.push({ field, message: `${label.due} is required when ${label.amount} is given.` });
        continue;
      }
      if (batch && due > batch.completionDate) {
        errors.push({ field, message: `${label.due} is after the batch completion date.` });
        continue;
      }

      if (installments.length > 0 && due < installments[installments.length - 1].dueDate) outOfOrder = true;
      installments.push({ amountPaise: rupeesToPaise(numeric), dueDate: due });
    }

    if (installments.length > config.installmentMax) {
      errors.push({
        field: "outstandingAmount",
        message: `${installments.length} opening installments given, but the institute allows at most ${config.installmentMax}.`,
      });
    }

    if (outOfOrder) {
      // Old-system exports rarely come sorted. Reordering is safer than
      // rejecting the row, but the Admin is told it happened.
      installments.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
      warnings.push({
        message: "Opening installments were not in date order — they have been renumbered earliest due date first.",
      });
    }

    const outstandingPaise = installments.reduce((sum, item) => sum + item.amountPaise, 0);

    const guardianName = text(v.guardianName);
    const relationRaw = (text(v.guardianRelation) ?? "guardian").toLowerCase().replace(/[^a-z]/g, "");
    const relation = RELATIONS[relationRaw];
    if (guardianName && !relation) {
      errors.push({ field: "guardianRelation", message: `Relation "${v.guardianRelation}" is not recognised.` });
    }
    if (!guardianName) {
      warnings.push({ message: "No guardian recorded — reminders will only reach the student's own contacts." });
    }
    if (!text(v.phone) && !text(v.email) && !text(v.guardianPhone) && !text(v.guardianEmail)) {
      warnings.push({ message: "No phone or email on the row — fee reminders cannot be delivered." });
    }

    const ok = errors.length === 0;
    if (ok) {
      if (lfNo !== null) seenLfNos.add(lfNo);
      if (nationalId) seenNationalIds.add(nationalId);
      if (batch) seatsTaken.set(batch.id, (seatsTaken.get(batch.id) ?? 0) + 1);
    }

    rows.push({
      rowNumber: raw.rowNumber,
      raw: v,
      errors,
      warnings,
      opening: { count: installments.length, totalPaise: outstandingPaise },
      resolved:
        ok && fullName && gender && department && course && batch && semesterId && status
          ? {
              fullName,
              gender,
              dob: dob === "invalid" ? null : dob,
              bloodGroup: text(v.bloodGroup),
              phone: text(v.phone),
              email: text(v.email),
              addressLine1: text(v.addressLine1),
              addressLine2: text(v.addressLine2),
              city: text(v.city),
              state: text(v.state),
              pincode: text(v.pincode),
              nationalId,
              previousEnrollmentNo: text(v.previousEnrollmentNo),
              departmentId: department.id,
              courseId: course.id,
              batchId: batch.id,
              semesterId,
              status,
              enrollmentDate,
              lfNo,
              guardian: guardianName
                ? {
                    name: guardianName,
                    relation: relation ?? "GUARDIAN",
                    phone: text(v.guardianPhone),
                    email: text(v.guardianEmail),
                    occupation: text(v.guardianOccupation),
                  }
                : null,
              installments,
            }
          : undefined,
    });
  }

  return {
    fileName,
    storagePath,
    totalRows: rows.length,
    validRows: rows.filter((row) => row.errors.length === 0).length,
    rows,
    fatal,
  };
}

/* -------------------------------------------------------------------------- */
/* Commit                                                                      */
/* -------------------------------------------------------------------------- */

export type ImportOutcome = { created: number; skipped: number; studentCodes: string[] };

/**
 * Writes the valid rows. Rows carrying errors are skipped, never partially
 * applied. The whole batch runs in one transaction so a failure leaves nothing
 * half-migrated.
 */
export async function commitImport(preview: ImportPreview, actorId: string): Promise<ImportOutcome> {
  const valid = preview.rows.filter((row) => row.resolved);
  if (valid.length === 0) {
    throw new ValidationError("There are no valid rows to import.");
  }

  const config = await getConfig();
  const studentCodes: string[] = [];

  // The file's own LF Nos are claimed row by row, so a number spelled out near
  // the end of the file is still off-limits to a blank row near the start.
  const spokenFor = valid
    .map((row) => row.resolved!.lfNo)
    .filter((lfNo): lfNo is number => lfNo !== null);

  await prisma.$transaction(
    async (tx) => {
      for (const row of valid) {
        const data = row.resolved!;
        const lfNo = data.lfNo ?? (await nextLfNo(tx, spokenFor));
        const studentCode = formatStudentCode(config.studentIdPrefix, lfNo, config.lfNoLength);

        const application = await tx.application.create({
          data: {
            fullName: data.fullName,
            gender: data.gender,
            dob: data.dob,
            bloodGroup: data.bloodGroup,
            phone: data.phone,
            email: data.email,
            addressLine1: data.addressLine1,
            addressLine2: data.addressLine2,
            city: data.city,
            state: data.state,
            pincode: data.pincode,
            nationalId: data.nationalId,
            previousEnrollmentNo: data.previousEnrollmentNo,
            departmentId: data.departmentId,
            courseId: data.courseId,
            batchId: data.batchId,
            status: "ENROLLED",
            submittedAt: data.enrollmentDate,
            reviewedAt: data.enrollmentDate,
            reviewedById: actorId,
            decisionReason: `Migrated via bulk import from ${preview.fileName} (row ${row.rowNumber})`,
            lfNo,
            studentCode,
            createdById: actorId,
          },
        });

        if (data.guardian) {
          await tx.guardian.create({
            data: {
              applicationId: application.id,
              name: data.guardian.name,
              relation: data.guardian.relation,
              phone: data.guardian.phone,
              email: data.guardian.email,
              occupation: data.guardian.occupation,
              isPrimary: true,
            },
          });
        }

        const student = await tx.student.create({
          data: {
            studentCode,
            lfNo,
            applicationId: application.id,
            fullName: data.fullName,
            gender: data.gender,
            dob: data.dob,
            bloodGroup: data.bloodGroup,
            phone: data.phone,
            email: data.email,
            addressLine1: data.addressLine1,
            addressLine2: data.addressLine2,
            city: data.city,
            state: data.state,
            pincode: data.pincode,
            nationalId: data.nationalId,
            departmentId: data.departmentId,
            courseId: data.courseId,
            batchId: data.batchId,
            currentSemesterId: data.semesterId,
            enrollmentDate: data.enrollmentDate,
            status: data.status,
          },
        });

        // Carry the old system's balance in as one clearly-labelled assignment
        // holding the student's remaining installments, so the ledger, the Fee
        // Due report and the reminder job are complete from day one.
        if (data.installments.length > 0) {
          const totalPaise = data.installments.reduce((sum, item) => sum + item.amountPaise, 0);
          const assignment = await tx.feeAssignment.create({
            data: {
              studentId: student.id,
              semesterId: data.semesterId,
              yearNumber: 1,
              totalPayablePaise: totalPaise,
              note: "Opening balance carried over during migration",
              createdById: actorId,
            },
          });
          await tx.installment.createMany({
            data: data.installments.map((item, index) => ({
              feeAssignmentId: assignment.id,
              seqNo: index + 1,
              dueDate: item.dueDate,
              amountPaise: item.amountPaise,
            })),
          });
        }

        studentCodes.push(studentCode);
      }
    },
    { timeout: 120_000 },
  );

  return {
    created: studentCodes.length,
    skipped: preview.rows.length - studentCodes.length,
    studentCodes,
  };
}
