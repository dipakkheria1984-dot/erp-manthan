import "server-only";
import { prisma } from "@/lib/db";
import { endOfDay, formatDate, fromDateInput } from "@/lib/dates";
import { studentStatusLabel } from "@/lib/students";
import type { ReportParams, ReportResult } from "./types";
import type { Prisma, StudentStatus } from "@/generated/prisma/client";

/** Shared student filter used by all three academic reports. */
function studentWhere(params: ReportParams): Prisma.StudentWhereInput {
  const from = params.from ? fromDateInput(params.from) : null;
  const to = params.to ? endOfDay(fromDateInput(params.to)) : null;

  return {
    ...(params.departmentId ? { departmentId: params.departmentId } : {}),
    ...(params.courseId ? { courseId: params.courseId } : {}),
    ...(params.batchId ? { batchId: params.batchId } : {}),
    ...(params.semesterId ? { currentSemesterId: params.semesterId } : {}),
    ...(params.gender ? { gender: params.gender as "MALE" | "FEMALE" | "OTHER" } : {}),
    // Dropped-out and expelled are excluded unless explicitly filtered (spec 7).
    ...(params.status
      ? { status: params.status as StudentStatus }
      : { status: { in: ["ACTIVE", "PASSED"] as StudentStatus[] } }),
    ...(from || to
      ? { enrollmentDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  };
}

export async function buildFilterSummary(
  params: ReportParams,
  /**
   * Only the student-scoped reports carry a status filter; printing the default
   * "active and passed" note on a fee report would describe a filter that does
   * not exist there.
   */
  options: { hasStatusFilter?: boolean } = { hasStatusFilter: true },
): Promise<string[]> {
  const summary: string[] = [];

  if (params.departmentId) {
    const dept = await prisma.department.findUnique({ where: { id: params.departmentId } });
    if (dept) summary.push(`Department: ${dept.code} — ${dept.name}`);
  }
  if (params.courseId) {
    const course = await prisma.course.findUnique({ where: { id: params.courseId } });
    if (course) summary.push(`Course: ${course.code} — ${course.name}`);
  }
  if (params.batchId) {
    const batch = await prisma.batch.findUnique({ where: { id: params.batchId } });
    if (batch) summary.push(`Batch: ${batch.code} — ${batch.name}`);
  }
  if (params.semesterId) {
    const semester = await prisma.semester.findUnique({ where: { id: params.semesterId } });
    if (semester) summary.push(`Semester: ${semester.semesterNumber}`);
  }
  if (params.academicYearId) {
    const year = await prisma.academicYear.findUnique({ where: { id: params.academicYearId } });
    if (year) summary.push(`Academic year: ${year.name}`);
  }
  if (params.studentId) {
    const student = await prisma.student.findUnique({ where: { id: params.studentId } });
    if (student) summary.push(`Student: ${student.studentCode} — ${student.fullName}`);
  }
  if (params.collectedById) {
    const user = await prisma.user.findUnique({ where: { id: params.collectedById } });
    if (user) summary.push(`Collected by: ${user.name}`);
  }
  if (params.status) summary.push(`Status: ${studentStatusLabel(params.status)}`);
  else if (options.hasStatusFilter) {
    summary.push("Status: Active and Passed (dropped-out and expelled excluded)");
  }
  if (params.gender) summary.push(`Gender: ${params.gender.toLowerCase()}`);
  if (params.mode) summary.push(`Payment mode: ${params.mode.replaceAll("_", " ").toLowerCase()}`);
  if (params.overdueBucket) summary.push(`Overdue bucket: ${params.overdueBucket} days`);
  if (params.lateFeeOnly === "with") summary.push("Only installments carrying a late fee");
  if (params.lateFeeOnly === "without") summary.push("Only installments without a late fee");
  if (params.paymentStatus) summary.push(`Receipt status: ${params.paymentStatus.toLowerCase()}`);

  if (params.from || params.to) {
    summary.push(
      `Date range: ${params.from ? formatDate(fromDateInput(params.from)) : "start"} to ${
        params.to ? formatDate(fromDateInput(params.to)) : "today"
      }`,
    );
  } else {
    summary.push("Date range: all dates");
  }

  return summary;
}

export async function studentRecordsReport(params: ReportParams): Promise<ReportResult> {
  const students = await prisma.student.findMany({
    where: studentWhere(params),
    include: { department: true, course: true, batch: true, currentSemester: true },
    orderBy: { studentCode: "asc" },
  });

  return {
    title: "Student Records",
    landscape: true,
    columns: [
      { key: "studentCode", header: "Student ID", width: 70 },
      { key: "fullName", header: "Name", width: 110 },
      { key: "dob", header: "DOB", width: 62 },
      { key: "gender", header: "Gender", width: 46 },
      { key: "contact", header: "Contact", width: 108 },
      { key: "department", header: "Department", width: 92 },
      { key: "course", header: "Course", width: 100 },
      { key: "batch", header: "Batch", width: 82 },
      { key: "semester", header: "Sem", width: 32, align: "right" },
      { key: "status", header: "Status", width: 58 },
      { key: "enrollmentDate", header: "Enrolled", width: 62 },
    ],
    rows: students.map((student) => ({
      studentCode: student.studentCode,
      fullName: student.fullName,
      dob: formatDate(student.dob),
      gender: student.gender.charAt(0) + student.gender.slice(1).toLowerCase(),
      contact: student.phone ?? student.email ?? "—",
      department: student.department.name,
      course: student.course.name,
      batch: student.batch.name,
      semester: student.currentSemester?.semesterNumber ?? "—",
      status: studentStatusLabel(student.status),
      enrollmentDate: formatDate(student.enrollmentDate),
    })),
    filterSummary: await buildFilterSummary(params),
    notes: [`${students.length} student(s) matched.`],
  };
}

export async function departmentWiseReport(params: ReportParams): Promise<ReportResult> {
  const where = studentWhere(params);
  const departments = await prisma.department.findMany({
    where: params.departmentId ? { id: params.departmentId } : {},
    include: { courses: true },
    orderBy: { name: "asc" },
  });

  const students = await prisma.student.findMany({
    where,
    select: { departmentId: true, courseId: true, status: true, course: { select: { name: true } } },
  });

  const rows = departments.map((department) => {
    const mine = students.filter((s) => s.departmentId === department.id);
    const byCourse = new Map<string, number>();
    for (const student of mine) {
      byCourse.set(student.course.name, (byCourse.get(student.course.name) ?? 0) + 1);
    }
    const count = (status: string) => mine.filter((s) => s.status === status).length;

    return {
      department: department.name,
      code: department.code,
      courses: department.courses.length,
      total: mine.length,
      breakup:
        [...byCourse.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name, n]) => `${name}: ${n}`)
          .join("; ") || "—",
      active: count("ACTIVE"),
      passed: count("PASSED"),
      droppedOut: count("DROPPED_OUT"),
      expelled: count("EXPELLED"),
    };
  });

  return {
    title: "Department-wise Summary",
    landscape: true,
    columns: [
      { key: "code", header: "Code", width: 50 },
      { key: "department", header: "Department", width: 120 },
      { key: "courses", header: "Courses", width: 50, align: "right" },
      { key: "total", header: "Students", width: 55, align: "right" },
      { key: "breakup", header: "Course-wise breakup", width: 250 },
      { key: "active", header: "Active", width: 48, align: "right" },
      { key: "passed", header: "Passed", width: 48, align: "right" },
      { key: "droppedOut", header: "Dropped", width: 52, align: "right" },
      { key: "expelled", header: "Expelled", width: 52, align: "right" },
    ],
    rows,
    totals: {
      code: "",
      department: "TOTAL",
      courses: rows.reduce((sum, r) => sum + r.courses, 0),
      total: rows.reduce((sum, r) => sum + r.total, 0),
      breakup: "",
      active: rows.reduce((sum, r) => sum + r.active, 0),
      passed: rows.reduce((sum, r) => sum + r.passed, 0),
      droppedOut: rows.reduce((sum, r) => sum + r.droppedOut, 0),
      expelled: rows.reduce((sum, r) => sum + r.expelled, 0),
    },
    filterSummary: await buildFilterSummary(params),
  };
}

export async function courseWiseReport(params: ReportParams): Promise<ReportResult> {
  const where = studentWhere(params);
  const courses = await prisma.course.findMany({
    where: {
      ...(params.courseId ? { id: params.courseId } : {}),
      ...(params.departmentId ? { departmentId: params.departmentId } : {}),
    },
    include: { department: true, batches: true },
    orderBy: { name: "asc" },
  });

  const students = await prisma.student.findMany({
    where,
    select: {
      courseId: true,
      status: true,
      batch: { select: { name: true } },
      currentSemester: { select: { semesterNumber: true } },
    },
  });

  const rows = courses.map((course) => {
    const mine = students.filter((s) => s.courseId === course.id);
    const byBatch = new Map<string, number>();
    const bySemester = new Map<number, number>();
    for (const student of mine) {
      byBatch.set(student.batch.name, (byBatch.get(student.batch.name) ?? 0) + 1);
      const sem = student.currentSemester?.semesterNumber ?? 0;
      bySemester.set(sem, (bySemester.get(sem) ?? 0) + 1);
    }
    const count = (status: string) => mine.filter((s) => s.status === status).length;

    return {
      code: course.code,
      course: course.name,
      department: course.department.name,
      total: mine.length,
      batchBreakup:
        [...byBatch.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name, n]) => `${name}: ${n}`)
          .join("; ") || "—",
      semesterDistribution:
        [...bySemester.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([sem, n]) => `Sem ${sem || "—"}: ${n}`)
          .join("; ") || "—",
      active: count("ACTIVE"),
      passed: count("PASSED"),
      droppedOut: count("DROPPED_OUT"),
      expelled: count("EXPELLED"),
    };
  });

  return {
    title: "Course-wise Summary",
    landscape: true,
    columns: [
      { key: "code", header: "Code", width: 48 },
      { key: "course", header: "Course", width: 118 },
      { key: "department", header: "Department", width: 92 },
      { key: "total", header: "Students", width: 52, align: "right" },
      { key: "batchBreakup", header: "Batch-wise breakup", width: 160 },
      { key: "semesterDistribution", header: "Semester distribution", width: 150 },
      { key: "active", header: "Active", width: 44, align: "right" },
      { key: "passed", header: "Passed", width: 44, align: "right" },
      { key: "droppedOut", header: "Dropped", width: 48, align: "right" },
      { key: "expelled", header: "Expelled", width: 48, align: "right" },
    ],
    rows,
    totals: {
      code: "",
      course: "TOTAL",
      department: "",
      total: rows.reduce((sum, r) => sum + r.total, 0),
      batchBreakup: "",
      semesterDistribution: "",
      active: rows.reduce((sum, r) => sum + r.active, 0),
      passed: rows.reduce((sum, r) => sum + r.passed, 0),
      droppedOut: rows.reduce((sum, r) => sum + r.droppedOut, 0),
      expelled: rows.reduce((sum, r) => sum + r.expelled, 0),
    },
    filterSummary: await buildFilterSummary(params),
  };
}
