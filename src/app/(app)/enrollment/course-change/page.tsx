import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { PERMISSIONS } from "@/lib/permissions";
import { loadCourseChangeContext } from "@/lib/course-change";
import { currentTuitionRate, installmentsFitting } from "@/lib/fees";
import { formatDate, startOfDay, toDateInput } from "@/lib/dates";
import { formatPaise, paiseToRupees } from "@/lib/money";
import { STUDENT_STATUS_TONE, studentStatusLabel } from "@/lib/students";
import {
  Alert,
  Badge,
  Card,
  DescriptionList,
  EmptyState,
  PageHeader,
  StatTile,
  TableWrap,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { StudentSearch } from "../../fees/collect/student-search";
import { TargetPicker } from "./target-picker";
import { CourseChangeForm, type TargetSemester } from "./course-change-form";

export const metadata = { title: "Course change" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/**
 * Move an enrolled student to a different course (Admin only).
 *
 * Three steps on one screen, each revealed by the one before it: find the
 * student, choose the course and batch they are moving to, then set the fee the
 * new course charges and the schedule for it. Nothing is written until the last
 * one is confirmed with a reason.
 *
 * What the change costs the old record is stated before it happens, not after:
 * the fee assignments it will scrap, the discounts that go with them, and the
 * money already collected that will be carried onto the new plan instead.
 */
export default async function CourseChangePage({ searchParams }: { searchParams: SearchParams }) {
  await requirePermission(PERMISSIONS.ENROLLMENT_CHANGE_COURSE);
  const params = await searchParams;
  const q = one(params.q);
  const studentId = one(params.studentId);
  const batchId = one(params.batchId);

  const matches = q
    ? await prisma.student.findMany({
        where: {
          OR: [
            { fullName: { contains: q, mode: "insensitive" } },
            { studentCode: { contains: q, mode: "insensitive" } },
            { phone: { contains: q } },
          ],
        },
        include: { batch: true, course: true },
        orderBy: { studentCode: "asc" },
        take: 20,
      })
    : [];

  const context = studentId ? await loadCourseChangeContext(studentId) : null;
  const student = context?.student ?? null;

  /* ---------------------------------------------------------------------- */
  /* Where they can move to                                                  */
  /* ---------------------------------------------------------------------- */

  const [departments, courses, openBatches] = student
    ? await Promise.all([
        prisma.department.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } }),
        prisma.course.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } }),
        prisma.batch.findMany({
          // A completed or discontinued batch takes nobody, and the batch the
          // student is already in is not a move.
          where: { status: { in: ["UPCOMING", "ONGOING"] }, id: { not: student.batchId } },
          include: { _count: { select: { students: true } } },
          orderBy: { name: "asc" },
        }),
      ])
    : [[], [], []];

  const target =
    student && batchId
      ? await prisma.batch.findUnique({
          where: { id: batchId },
          include: {
            course: { include: { department: true } },
            semesters: { orderBy: { semesterNumber: "asc" } },
            _count: { select: { students: true } },
          },
        })
      : null;

  const [config, targetRatePaise] = await Promise.all([
    getConfig(),
    target ? currentTuitionRate(target.id) : Promise.resolve(0),
  ]);

  const rupeeField = (paise: number) => paiseToRupees(paise).toFixed(2);

  // Tuition is charged on the year of the course, carried by the semester that
  // opens it (spec 6.4). A student joining mid-year is normally charged the exam
  // and activity fees only — what they were charged on the old course is being
  // scrapped and credited back to them either way, so the Admin decides.
  const firstSemesterOfYear = new Map<number, number>();
  for (const semester of target?.semesters ?? []) {
    const lowest = firstSemesterOfYear.get(semester.yearNumber);
    if (lowest === undefined || semester.semesterNumber < lowest) {
      firstSemesterOfYear.set(semester.yearNumber, semester.semesterNumber);
    }
  }

  const targetSemesters: TargetSemester[] = (target?.semesters ?? []).map((semester) => {
    const opensYear = firstSemesterOfYear.get(semester.yearNumber) === semester.semesterNumber;
    return {
      id: semester.id,
      label: `Semester ${semester.semesterNumber} — Year ${semester.yearNumber}`,
      tuition: rupeeField(opensYear ? targetRatePaise : 0),
      examFee: rupeeField(semester.examFeePaise),
      activityFee: rupeeField(semester.activityFeePaise),
      hint: opensYear
        ? `Semester ${semester.semesterNumber} opens year ${semester.yearNumber} of the course, so it carries that year's tuition.`
        : `Semester ${semester.semesterNumber} does not open a year of the course, so it normally carries exam and activity fees only. Enter a tuition rate if this transfer is meant to charge for the year.`,
    };
  });

  // The concession the family already had, offered again on the new course.
  const oldest = student?.feeAssignments[0];
  const carriesAmountScholarship = Boolean(oldest && oldest.scholarshipAmountPaise > 0 && oldest.scholarshipPercent === 0);
  const initialScholarship = {
    basis: (carriesAmountScholarship ? "AMOUNT" : "PERCENT") as "PERCENT" | "AMOUNT",
    percent: String(oldest?.scholarshipPercent ?? 0),
    amount: carriesAmountScholarship ? rupeeField(oldest?.scholarshipAmountPaise ?? 0) : "",
  };

  const today = startOfDay(new Date());
  const fitting = target ? installmentsFitting(today, target.completionDate) : 0;
  const defaultInstallmentCount = Math.max(config.installmentMin, Math.min(config.installmentMax, fitting || 1));

  // Two different dead ends, kept apart on purpose: a student who cannot be
  // moved at all, and a batch that cannot take them. The second must still
  // leave the picker on screen, or choosing a full batch traps you there.
  const studentBlocked =
    student && student.status !== "ACTIVE"
      ? `${student.studentCode} is ${studentStatusLabel(student.status).toLowerCase()}. Only an active student can be moved to another course — put the status right first.`
      : null;
  const targetBlocked =
    target && target._count.students >= target.totalSeats
      ? `${target.name} is full. There is no waitlist, so a seat has to come free before anyone can join it — choose another batch.`
      : null;

  return (
    <>
      <PageHeader
        title="Course change"
        description="Move an enrolled student to a different course. The fee structure that came with the old course is scrapped and the new course's fee is assigned in its place — every payment already received is carried across and settles the new schedule."
      />

      <div className="space-y-6">
        <Card title="Find the student">
          <StudentSearch defaultQuery={q} />
          {q && matches.length > 0 ? (
            <div className="mt-4">
              <TableWrap>
                <thead>
                  <tr>
                    <Th>Student ID</Th>
                    <Th>Name</Th>
                    <Th>Course</Th>
                    <Th>Batch</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((match) => (
                    <Tr key={match.id}>
                      <Td>
                        <Link
                          href={`/enrollment/course-change?studentId=${match.id}`}
                          className="font-mono text-xs text-brand hover:underline"
                        >
                          {match.studentCode}
                        </Link>
                      </Td>
                      <Td className="font-medium">{match.fullName}</Td>
                      <Td>{match.course.name}</Td>
                      <Td>{match.batch.name}</Td>
                      <Td>{studentStatusLabel(match.status)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </TableWrap>
            </div>
          ) : null}
          {q && matches.length === 0 ? <p className="mt-4 text-sm text-muted">No students matched “{q}”.</p> : null}
          {!q && !student ? (
            <p className="mt-4 text-sm text-muted">
              Search by student ID, name or phone number. Only enrolled students can change course.
            </p>
          ) : null}
        </Card>

        {student && context ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Student" value={student.studentCode} hint={student.fullName} />
              <StatTile label="Current course" value={student.course.name} hint={`${student.batch.name} · ${student.batch.code}`} />
              <StatTile
                label="Fee to be scrapped"
                value={formatPaise(context.scrapped.assignedPaise)}
                tone={context.scrapped.assignedPaise > 0 ? "warning" : "default"}
                hint={`${context.scrapped.assignmentCount} assignment(s), ${context.scrapped.installmentCount} installment(s)`}
              />
              <StatTile
                label="Collected so far"
                value={formatPaise(context.carriedPaise)}
                tone="success"
                hint="Carried across in full"
              />
            </div>

            {studentBlocked ? (
              <Alert tone="danger" title="This student cannot be moved">
                {studentBlocked}
              </Alert>
            ) : null}
            {targetBlocked ? (
              <Alert tone="warning" title="That batch has no room">
                {targetBlocked}
              </Alert>
            ) : null}

            <Card title="What this change will do">
              <DescriptionList
                items={[
                  {
                    label: "Fee assignments scrapped",
                    value: `${context.scrapped.assignmentCount} — ${formatPaise(context.scrapped.assignedPaise)} over ${context.scrapped.installmentCount} installment(s)`,
                  },
                  {
                    label: "Payments kept",
                    value: `${formatPaise(context.carriedPaise)} across ${context.carriedPayments.length} receipt line(s) — re-applied to the new schedule, oldest first`,
                  },
                  {
                    label: "Discounts cancelled",
                    value:
                      context.scrapped.activeDiscountCount > 0
                        ? `${context.scrapped.activeDiscountCount} — ${formatPaise(context.scrapped.activeDiscountPaise)}. They were concessions on the old fee; grant them again on the new plan if they still apply.`
                        : "None",
                  },
                  {
                    label: "Late fee written off",
                    value:
                      context.scrapped.lateFeePaise > 0
                        ? `${formatPaise(context.scrapped.lateFeePaise)} accrued and unpaid — it dies with the due dates it was charged against.`
                        : "None accrued",
                  },
                  {
                    label: "Extra charges scrapped",
                    value:
                      context.scrapped.extraChargeCount > 0
                        ? `${context.scrapped.extraChargeCount} — fines and event charges raised on the old course go too. Raise them again on the new assignment if they still stand.`
                        : "None",
                  },
                  {
                    label: "Waived installments",
                    value: context.scrapped.waivedCount > 0 ? `${context.scrapped.waivedCount} — removed with the rest` : "None",
                  },
                ]}
              />
              {context.scrapped.assignmentCount === 0 ? (
                <div className="mt-4">
                  <Alert tone="info" title="Nothing is assigned to this student yet">
                    There is no fee structure to scrap, so this change only moves them and bills the new course.
                  </Alert>
                </div>
              ) : null}
            </Card>

            {!studentBlocked ? (
              <Card
                title="Move them to"
                description="Pick the course and batch. The tuition rate, the semesters on offer and the last permitted due date all come from the batch chosen here."
              >
                <TargetPicker
                  studentId={student.id}
                  departments={departments}
                  courses={courses.map((course) => ({
                    id: course.id,
                    name: course.name,
                    departmentId: course.departmentId,
                  }))}
                  batches={openBatches.map((batch) => ({
                    id: batch.id,
                    name: batch.name,
                    code: batch.code,
                    courseId: batch.courseId,
                    seatsLeft: Math.max(0, batch.totalSeats - batch._count.students),
                  }))}
                  selectedBatchId={batchId}
                />
              </Card>
            ) : null}

            {!studentBlocked && !targetBlocked && target && targetSemesters.length > 0 ? (
              <CourseChangeForm
                studentId={student.id}
                studentCode={student.studentCode}
                target={{
                  departmentId: target.course.departmentId,
                  courseId: target.courseId,
                  batchId: target.id,
                  courseName: target.course.name,
                  batchLabel: `${target.name} (${target.code})`,
                  completionDate: toDateInput(target.completionDate),
                  completionDateLabel: formatDate(target.completionDate),
                }}
                semesters={targetSemesters}
                defaultSemesterId={targetSemesters[0].id}
                initialScholarship={initialScholarship}
                installmentMin={config.installmentMin}
                installmentMax={config.installmentMax}
                defaultInstallmentCount={defaultInstallmentCount}
                defaultFirstDueDate={toDateInput(today)}
                carriedPaise={context.carriedPaise}
                carriedLateFeePaise={context.carriedLateFeePaise}
              />
            ) : null}

            {!studentBlocked && !targetBlocked && target && targetSemesters.length === 0 ? (
              <Alert tone="warning" title="That batch has no semesters configured">
                A fee cannot be assigned until the batch has at least one semester. Set them up under Academics →
                Batches, then come back.
              </Alert>
            ) : null}
          </>
        ) : studentId ? (
          <EmptyState title="Student not found." description="They may have been removed since the link was made." />
        ) : null}
      </div>
    </>
  );
}
