import "server-only";
import { prisma, type Db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { startOfDay } from "@/lib/dates";
import { semesterLayout } from "@/lib/academic";
import { recordAuditTx } from "@/lib/audit";
import {
  isCsv,
  mapHeaders,
  parseDate,
  parseRupees,
  parseWholeNumber,
  readSheets,
  text,
  type ImportColumn,
  type ImportIssue,
} from "@/lib/imports/grid";

/**
 * Bulk import of the academic structure — departments, courses and batches
 * (spec 5.1–5.3).
 *
 * One workbook with three sheets, applied in dependency order, so an institute
 * can be set up from a single file: a course may name a department created on
 * the sheet before it, and a batch may name a course created on the sheet before
 * it. That ordering is why this is a workbook rather than three uploads.
 *
 * Creation only. A code that already exists is an error rather than a silent
 * overwrite — academic structure is edited from its own screens, where the rules
 * about changing a semester count or deactivating something with students
 * attached are enforced.
 */

export const SHEETS = {
  departments: { name: "Departments", key: "departments" },
  courses: { name: "Courses", key: "courses" },
  batches: { name: "Batches", key: "batches" },
} as const;

export const DEPARTMENT_COLUMNS: ImportColumn[] = [
  { key: "code", header: "Code", required: true, help: "Unique short code, e.g. CE. Stored in upper case." },
  { key: "name", header: "Name", required: true, help: "Full department name." },
  { key: "headOfDepartment", header: "Head of Department", help: "Optional." },
  { key: "status", header: "Status", help: "Active or Inactive. Defaults to Active." },
];

export const COURSE_COLUMNS: ImportColumn[] = [
  { key: "code", header: "Code", required: true, help: "Unique short code, e.g. BTCE. Stored in upper case." },
  { key: "name", header: "Name", required: true, help: "Full course name." },
  {
    key: "departmentCode",
    header: "Department Code",
    required: true,
    help: "An existing department, or one created on the Departments sheet of this same file.",
  },
  { key: "durationYears", header: "Duration Years", required: true, help: "Whole number, 1 to 10." },
  {
    key: "totalSemesters",
    header: "Total Semesters",
    required: true,
    help: "Whole number, 2 to 20. Single-semester courses are not allowed.",
  },
  { key: "status", header: "Status", help: "Active, Inactive or Discontinued. Defaults to Active." },
];

export const BATCH_COLUMNS: ImportColumn[] = [
  { key: "code", header: "Code", required: true, help: "Unique short code, e.g. BTCE26. Stored in upper case." },
  { key: "name", header: "Name", required: true, help: "Full batch name." },
  {
    key: "courseCode",
    header: "Course Code",
    required: true,
    help: "An existing course, or one created on the Courses sheet of this same file.",
  },
  { key: "startDate", header: "Start Date", required: true, help: "YYYY-MM-DD or DD/MM/YYYY." },
  {
    key: "completionDate",
    header: "Completion Date",
    required: true,
    help: "Must be after the start date. No installment may fall due after it.",
  },
  { key: "totalSeats", header: "Total Seats", required: true, help: "Whole number, 1 to 10000. There is no waitlist." },
  {
    key: "tuitionFee",
    header: "Preset Tuition Fee",
    required: true,
    help: "Per-year tuition in rupees, recorded as the batch's opening fee version. Students lock this rate at enrollment.",
  },
  { key: "status", header: "Status", help: "Upcoming, Ongoing, Completed or Discontinued. Defaults to Upcoming." },
];

const DEPARTMENT_STATUS: Record<string, "ACTIVE" | "INACTIVE"> = { active: "ACTIVE", inactive: "INACTIVE" };
const COURSE_STATUS: Record<string, "ACTIVE" | "INACTIVE" | "DISCONTINUED"> = {
  active: "ACTIVE",
  inactive: "INACTIVE",
  discontinued: "DISCONTINUED",
};
const BATCH_STATUS: Record<string, "UPCOMING" | "ONGOING" | "COMPLETED" | "DISCONTINUED"> = {
  upcoming: "UPCOMING",
  ongoing: "ONGOING",
  completed: "COMPLETED",
  discontinued: "DISCONTINUED",
};

type ResolvedDepartment = {
  code: string;
  name: string;
  headOfDepartment: string | null;
  status: "ACTIVE" | "INACTIVE";
};
type ResolvedCourse = {
  code: string;
  name: string;
  departmentCode: string;
  durationYears: number;
  totalSemesters: number;
  status: "ACTIVE" | "INACTIVE" | "DISCONTINUED";
};
type ResolvedBatch = {
  code: string;
  name: string;
  courseCode: string;
  startDate: Date;
  completionDate: Date;
  totalSeats: number;
  tuitionFeePaise: number;
  status: "UPCOMING" | "ONGOING" | "COMPLETED" | "DISCONTINUED";
};

export type AcademicRow = {
  rowNumber: number;
  sheet: "Departments" | "Courses" | "Batches";
  /** Cells for the preview table: Code, Name, Details, Status. */
  display: string[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
  department?: ResolvedDepartment;
  course?: ResolvedCourse;
  batch?: ResolvedBatch;
};

export type AcademicPreview = {
  fileName: string;
  storagePath: string;
  totalRows: number;
  validRows: number;
  rows: AcademicRow[];
  fatal: string[];
  counts: { departments: number; courses: number; batches: number };
};

function statusOf<T extends string>(
  raw: string | null,
  lookup: Record<string, T>,
  fallback: T,
): T | "invalid" {
  if (!raw) return fallback;
  return lookup[raw.toLowerCase().replace(/[^a-z]/g, "")] ?? "invalid";
}

export async function prepareAcademicImport(
  storagePath: string,
  fileName: string,
  db: Db = prisma,
): Promise<AcademicPreview> {
  const empty: AcademicPreview = {
    fileName,
    storagePath,
    totalRows: 0,
    validRows: 0,
    rows: [],
    fatal: [],
    counts: { departments: 0, courses: 0, batches: 0 },
  };

  if (isCsv(storagePath)) {
    return {
      ...empty,
      fatal: [
        "The academic import needs the three-sheet workbook — departments, courses and batches must be in one file so " +
          "they can be created in order. Download the .xlsx template and use that.",
      ],
    };
  }

  const sheets = await readSheets(storagePath);
  const missing = Object.values(SHEETS)
    .filter((sheet) => !sheets.has(sheet.key))
    .map((sheet) => sheet.name);
  if (missing.length === Object.keys(SHEETS).length) {
    return {
      ...empty,
      fatal: [`None of the expected sheets were found. The workbook needs sheets named ${Object.values(SHEETS).map((s) => s.name).join(", ")}.`],
    };
  }

  const [existingDepartments, existingCourses, existingBatches] = await Promise.all([
    db.department.findMany({ select: { code: true } }),
    db.course.findMany({ select: { code: true, status: true } }),
    db.batch.findMany({ select: { code: true } }),
  ]);

  const fatal: string[] = [];
  const rows: AcademicRow[] = [];

  // Codes seen so far, so a course can point at a department created earlier in
  // this same file and a duplicate inside the file is caught.
  const departmentCodes = new Set(existingDepartments.map((d) => d.code.toUpperCase()));
  const courseCodes = new Map(existingCourses.map((c) => [c.code.toUpperCase(), c.status as string]));
  const batchCodes = new Set(existingBatches.map((b) => b.code.toUpperCase()));
  const fileDepartments = new Set<string>();
  const fileCourses = new Set<string>();
  const fileBatches = new Set<string>();
  // Courses defined in this file, needed for a batch's semester layout.
  const pendingCourseShape = new Map<string, { totalSemesters: number; durationYears: number; status: string }>();

  /* ---- Departments -------------------------------------------------------- */

  const departmentGrid = sheets.get(SHEETS.departments.key) ?? [];
  if (departmentGrid.length > 0) {
    const index = mapHeaders(departmentGrid[0], DEPARTMENT_COLUMNS);
    const missingColumns = DEPARTMENT_COLUMNS.filter((c) => c.required && !index.has(c.key));
    if (missingColumns.length > 0) {
      fatal.push(`Departments sheet is missing: ${missingColumns.map((c) => c.header).join(", ")}.`);
    } else {
      departmentGrid.slice(1).forEach((cells, i) => {
        const get = (key: string) => text(cells[index.get(key) ?? -1]);
        const errors: ImportIssue[] = [];
        const warnings: ImportIssue[] = [];

        const code = get("code")?.toUpperCase() ?? null;
        const name = get("name");
        if (!code) errors.push({ field: "code", message: "Code is required." });
        else if (departmentCodes.has(code)) errors.push({ field: "code", message: `Department ${code} already exists.` });
        else if (fileDepartments.has(code)) errors.push({ field: "code", message: `Code ${code} appears twice on this sheet.` });
        if (!name) errors.push({ field: "name", message: "Name is required." });

        const status = statusOf(get("status"), DEPARTMENT_STATUS, "ACTIVE");
        if (status === "invalid") errors.push({ field: "status", message: `Status "${get("status")}" is not Active or Inactive.` });

        const ok = errors.length === 0 && code && name && status !== "invalid";
        if (ok) fileDepartments.add(code);

        rows.push({
          rowNumber: i + 2,
          sheet: "Departments",
          display: [code ?? "—", name ?? "—", get("headOfDepartment") ?? "—", status === "invalid" ? "—" : status],
          errors,
          warnings,
          department: ok
            ? { code, name, headOfDepartment: get("headOfDepartment"), status: status as "ACTIVE" | "INACTIVE" }
            : undefined,
        });
      });
    }
  }

  /* ---- Courses ------------------------------------------------------------ */

  const courseGrid = sheets.get(SHEETS.courses.key) ?? [];
  if (courseGrid.length > 0) {
    const index = mapHeaders(courseGrid[0], COURSE_COLUMNS);
    const missingColumns = COURSE_COLUMNS.filter((c) => c.required && !index.has(c.key));
    if (missingColumns.length > 0) {
      fatal.push(`Courses sheet is missing: ${missingColumns.map((c) => c.header).join(", ")}.`);
    } else {
      courseGrid.slice(1).forEach((cells, i) => {
        const get = (key: string) => text(cells[index.get(key) ?? -1]);
        const errors: ImportIssue[] = [];
        const warnings: ImportIssue[] = [];

        const code = get("code")?.toUpperCase() ?? null;
        const name = get("name");
        const departmentCode = get("departmentCode")?.toUpperCase() ?? null;

        if (!code) errors.push({ field: "code", message: "Code is required." });
        else if (courseCodes.has(code)) errors.push({ field: "code", message: `Course ${code} already exists.` });
        else if (fileCourses.has(code)) errors.push({ field: "code", message: `Code ${code} appears twice on this sheet.` });
        if (!name) errors.push({ field: "name", message: "Name is required." });

        if (!departmentCode) {
          errors.push({ field: "departmentCode", message: "Department Code is required." });
        } else if (!departmentCodes.has(departmentCode) && !fileDepartments.has(departmentCode)) {
          errors.push({
            field: "departmentCode",
            message: `No department with code "${departmentCode}" — it is neither in the system nor on the Departments sheet.`,
          });
        }

        const durationYears = parseWholeNumber(get("durationYears") ?? undefined);
        if (durationYears === null) errors.push({ field: "durationYears", message: "Duration Years is required." });
        else if (durationYears === "invalid" || durationYears < 1 || durationYears > 10) {
          errors.push({ field: "durationYears", message: "Duration Years must be a whole number between 1 and 10." });
        }

        const totalSemesters = parseWholeNumber(get("totalSemesters") ?? undefined);
        if (totalSemesters === null) errors.push({ field: "totalSemesters", message: "Total Semesters is required." });
        else if (totalSemesters === "invalid" || totalSemesters < 2 || totalSemesters > 20) {
          // Spec 5.2 — single-semester courses are not allowed.
          errors.push({ field: "totalSemesters", message: "Total Semesters must be a whole number between 2 and 20." });
        }

        const status = statusOf(get("status"), COURSE_STATUS, "ACTIVE");
        if (status === "invalid") {
          errors.push({ field: "status", message: `Status "${get("status")}" is not Active, Inactive or Discontinued.` });
        }

        const ok =
          errors.length === 0 &&
          code &&
          name &&
          departmentCode &&
          typeof durationYears === "number" &&
          typeof totalSemesters === "number" &&
          status !== "invalid";

        if (ok) {
          fileCourses.add(code);
          pendingCourseShape.set(code, { totalSemesters, durationYears, status });
        }

        rows.push({
          rowNumber: i + 2,
          sheet: "Courses",
          display: [
            code ?? "—",
            name ?? "—",
            `${departmentCode ?? "—"} · ${get("durationYears") ?? "—"}y · ${get("totalSemesters") ?? "—"} sem`,
            status === "invalid" ? "—" : status,
          ],
          errors,
          warnings,
          course: ok
            ? {
                code,
                name,
                departmentCode,
                durationYears,
                totalSemesters,
                status: status as ResolvedCourse["status"],
              }
            : undefined,
        });
      });
    }
  }

  /* ---- Batches ------------------------------------------------------------ */

  const batchGrid = sheets.get(SHEETS.batches.key) ?? [];
  if (batchGrid.length > 0) {
    const index = mapHeaders(batchGrid[0], BATCH_COLUMNS);
    const missingColumns = BATCH_COLUMNS.filter((c) => c.required && !index.has(c.key));
    if (missingColumns.length > 0) {
      fatal.push(`Batches sheet is missing: ${missingColumns.map((c) => c.header).join(", ")}.`);
    } else {
      batchGrid.slice(1).forEach((cells, i) => {
        const get = (key: string) => text(cells[index.get(key) ?? -1]);
        const errors: ImportIssue[] = [];
        const warnings: ImportIssue[] = [];

        const code = get("code")?.toUpperCase() ?? null;
        const name = get("name");
        const courseCode = get("courseCode")?.toUpperCase() ?? null;

        if (!code) errors.push({ field: "code", message: "Code is required." });
        else if (batchCodes.has(code)) errors.push({ field: "code", message: `Batch ${code} already exists.` });
        else if (fileBatches.has(code)) errors.push({ field: "code", message: `Code ${code} appears twice on this sheet.` });
        if (!name) errors.push({ field: "name", message: "Name is required." });

        const courseStatus = courseCode
          ? (pendingCourseShape.get(courseCode)?.status ?? courseCodes.get(courseCode) ?? null)
          : null;
        if (!courseCode) {
          errors.push({ field: "courseCode", message: "Course Code is required." });
        } else if (courseStatus === null) {
          errors.push({
            field: "courseCode",
            message: `No course with code "${courseCode}" — it is neither in the system nor on the Courses sheet.`,
          });
        } else if (courseStatus === "DISCONTINUED") {
          // Spec 5.2 — existing batches continue, but no new ones.
          errors.push({ field: "courseCode", message: `Course ${courseCode} is discontinued, so no new batch can be created under it.` });
        }

        const start = parseDate(get("startDate") ?? undefined);
        if (start === null) errors.push({ field: "startDate", message: "Start Date is required." });
        else if (start === "invalid") errors.push({ field: "startDate", message: "Start Date is not a valid date." });

        const completion = parseDate(get("completionDate") ?? undefined);
        if (completion === null) errors.push({ field: "completionDate", message: "Completion Date is required." });
        else if (completion === "invalid") errors.push({ field: "completionDate", message: "Completion Date is not a valid date." });
        else if (start instanceof Date && completion <= start) {
          errors.push({ field: "completionDate", message: "Completion Date must be after the Start Date." });
        }

        const totalSeats = parseWholeNumber(get("totalSeats") ?? undefined);
        if (totalSeats === null) errors.push({ field: "totalSeats", message: "Total Seats is required." });
        else if (totalSeats === "invalid" || totalSeats < 1 || totalSeats > 10000) {
          errors.push({ field: "totalSeats", message: "Total Seats must be a whole number between 1 and 10000." });
        }

        const tuition = parseRupees(get("tuitionFee") ?? undefined);
        if (tuition === null) errors.push({ field: "tuitionFee", message: "Preset Tuition Fee is required." });
        else if (tuition === "invalid" || tuition < 0) {
          errors.push({ field: "tuitionFee", message: "Preset Tuition Fee must be a non-negative amount." });
        } else if (tuition === 0) {
          warnings.push({ field: "tuitionFee", message: "Tuition is zero — students in this batch will be charged exam and activity fees only." });
        }

        const status = statusOf(get("status"), BATCH_STATUS, "UPCOMING");
        if (status === "invalid") {
          errors.push({ field: "status", message: `Status "${get("status")}" is not Upcoming, Ongoing, Completed or Discontinued.` });
        }

        const ok =
          errors.length === 0 &&
          code &&
          name &&
          courseCode &&
          start instanceof Date &&
          completion instanceof Date &&
          typeof totalSeats === "number" &&
          typeof tuition === "number" &&
          status !== "invalid";

        if (ok) fileBatches.add(code);

        rows.push({
          rowNumber: i + 2,
          sheet: "Batches",
          display: [
            code ?? "—",
            name ?? "—",
            `${courseCode ?? "—"} · ${get("startDate") ?? "—"} → ${get("completionDate") ?? "—"} · ${
              get("totalSeats") ?? "—"
            } seats · ${typeof tuition === "number" ? formatPaise(rupeesToPaise(tuition)) : "—"}`,
            status === "invalid" ? "—" : status,
          ],
          errors,
          warnings,
          batch: ok
            ? {
                code,
                name,
                courseCode,
                startDate: start,
                completionDate: completion,
                totalSeats,
                tuitionFeePaise: rupeesToPaise(tuition),
                status: status as ResolvedBatch["status"],
              }
            : undefined,
        });
      });
    }
  }

  const validRows = rows.filter((row) => row.errors.length === 0).length;
  return {
    fileName,
    storagePath,
    totalRows: rows.length,
    validRows,
    rows,
    fatal,
    counts: {
      departments: rows.filter((r) => r.department).length,
      courses: rows.filter((r) => r.course).length,
      batches: rows.filter((r) => r.batch).length,
    },
  };
}

export type AcademicOutcome = { departments: number; courses: number; batches: number; skipped: number };

/**
 * Writes the valid rows in dependency order inside one transaction, so a failure
 * anywhere leaves the structure untouched rather than half-built.
 */
export async function commitAcademicImport(
  preview: AcademicPreview,
  actorId: string,
): Promise<AcademicOutcome> {
  const departments = preview.rows.map((r) => r.department).filter((d): d is ResolvedDepartment => Boolean(d));
  const courses = preview.rows.map((r) => r.course).filter((c): c is ResolvedCourse => Boolean(c));
  const batches = preview.rows.map((r) => r.batch).filter((b): b is ResolvedBatch => Boolean(b));

  if (departments.length + courses.length + batches.length === 0) {
    throw new ValidationError("There are no valid rows to import.");
  }

  await prisma.$transaction(
    async (tx) => {
      const departmentIds = new Map<string, string>(
        (await tx.department.findMany({ select: { id: true, code: true } })).map((d) => [d.code.toUpperCase(), d.id]),
      );
      for (const department of departments) {
        const created = await tx.department.create({ data: department });
        departmentIds.set(department.code, created.id);
      }

      const courseIds = new Map<string, { id: string; totalSemesters: number; durationYears: number }>(
        (await tx.course.findMany({ select: { id: true, code: true, totalSemesters: true, durationYears: true } })).map(
          (c) => [c.code.toUpperCase(), { id: c.id, totalSemesters: c.totalSemesters, durationYears: c.durationYears }],
        ),
      );
      for (const course of courses) {
        const departmentId = departmentIds.get(course.departmentCode);
        if (!departmentId) throw new ValidationError(`Department ${course.departmentCode} disappeared before ${course.code} could be created.`);
        const { departmentCode: _departmentCode, ...data } = course;
        const created = await tx.course.create({ data: { ...data, departmentId } });
        courseIds.set(course.code, {
          id: created.id,
          totalSemesters: course.totalSemesters,
          durationYears: course.durationYears,
        });
      }

      const currentYear = await tx.academicYear.findFirst({ where: { isCurrent: true } });
      for (const batch of batches) {
        const course = courseIds.get(batch.courseCode);
        if (!course) throw new ValidationError(`Course ${batch.courseCode} disappeared before ${batch.code} could be created.`);

        const { courseCode: _courseCode, tuitionFeePaise, ...data } = batch;
        const created = await tx.batch.create({ data: { ...data, courseId: course.id } });

        await tx.batchFeeHistory.create({
          data: {
            batchId: created.id,
            tuitionFeePaise,
            effectiveFrom: startOfDay(batch.startDate),
            note: "Initial preset fee (bulk import)",
            createdById: actorId,
          },
        });

        // Same layout the batch editor produces, so an imported batch is
        // indistinguishable from a hand-created one.
        const slots = semesterLayout({
          startDate: batch.startDate,
          completionDate: batch.completionDate,
          totalSemesters: course.totalSemesters,
          durationYears: course.durationYears,
        });
        await tx.semester.createMany({
          data: slots.map((slot) => ({
            batchId: created.id,
            semesterNumber: slot.semesterNumber,
            startDate: slot.startDate,
            endDate: slot.endDate,
            yearNumber: slot.yearNumber,
            academicYearId: slot.isFirstYear ? (currentYear?.id ?? null) : null,
          })),
        });
      }

      await recordAuditTx(tx, {
        userId: actorId,
        action: "academic.bulk_imported",
        summary:
          `Academic structure imported from ${preview.fileName} — ` +
          `${departments.length} department(s), ${courses.length} course(s), ${batches.length} batch(es)`,
        metadata: {
          departments: departments.map((d) => d.code),
          courses: courses.map((c) => c.code),
          batches: batches.map((b) => b.code),
        },
      });
    },
    { timeout: 120_000 },
  );

  return {
    departments: departments.length,
    courses: courses.length,
    batches: batches.length,
    skipped: preview.rows.length - (departments.length + courses.length + batches.length),
  };
}
