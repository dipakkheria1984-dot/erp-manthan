import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getCurrentAcademicYear } from "@/lib/config";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { formatPaise } from "@/lib/money";
import { startOfDay } from "@/lib/dates";
import { Alert, Card, LinkButton, PageHeader, StatTile } from "@/components/ui";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await requireUser();
  const can = (p: Parameters<typeof hasPermission>[1]) => hasPermission(user.permissions, p);

  const academicYear = await getCurrentAcademicYear();
  const today = startOfDay(new Date());

  const [activeStudents, pendingApplications, totalDueAgg, collectedTodayAgg, overdueCount] = await Promise.all([
    can(PERMISSIONS.STUDENT_VIEW) ? prisma.student.count({ where: { status: "ACTIVE" } }) : Promise.resolve(null),
    can(PERMISSIONS.ENROLLMENT_VIEW)
      ? prisma.application.count({ where: { status: { in: ["SUBMITTED", "UNDER_REVIEW"] } } })
      : Promise.resolve(null),
    can(PERMISSIONS.REPORT_FEE_DUE)
      ? prisma.installment.aggregate({
          _sum: { amountPaise: true },
          where: { status: { in: ["PENDING", "PARTIALLY_PAID"] } },
        })
      : Promise.resolve(null),
    can(PERMISSIONS.REPORT_FEE_COLLECTION)
      ? prisma.payment.aggregate({
          _sum: { amountPaise: true },
          where: { status: "ACTIVE", paymentDate: { gte: today } },
        })
      : Promise.resolve(null),
    can(PERMISSIONS.REPORT_FEE_DUE)
      ? prisma.installment.count({
          where: { status: { in: ["PENDING", "PARTIALLY_PAID"] }, dueDate: { lt: today } },
        })
      : Promise.resolve(null),
  ]);

  const tiles = [
    activeStudents !== null && { label: "Active students", value: activeStudents.toLocaleString("en-IN") },
    pendingApplications !== null && {
      label: "Applications awaiting review",
      value: pendingApplications.toLocaleString("en-IN"),
      tone: pendingApplications > 0 ? ("warning" as const) : undefined,
    },
    collectedTodayAgg && {
      label: "Collected today",
      value: formatPaise(collectedTodayAgg._sum.amountPaise ?? 0),
      hint: "Excludes cancelled receipts",
    },
    totalDueAgg && {
      label: "Outstanding (gross)",
      value: formatPaise(totalDueAgg._sum.amountPaise ?? 0),
      hint: overdueCount !== null ? `${overdueCount} installment(s) past due` : undefined,
      tone: "danger" as const,
    },
  ].filter(Boolean) as { label: string; value: string; hint?: string; tone?: "success" | "warning" | "danger" }[];

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name.split(" ")[0]}`}
        description={
          academicYear
            ? `Current academic year: ${academicYear.name}`
            : "No academic year is marked current — set one in Institute Setup."
        }
      />

      {!academicYear && can(PERMISSIONS.INSTITUTE_MANAGE) ? (
        <div className="mb-6">
          <Alert tone="warning" title="Setup incomplete">
            Enrollment needs a current academic year.{" "}
            <a className="underline" href="/setup/academic-years">
              Define one now
            </a>
            .
          </Alert>
        </div>
      ) : null}

      {/* `stagger` lands the tiles one after another, so the dashboard
          assembles itself instead of blinking into place. */}
      {tiles.length > 0 ? (
        <div className="stagger mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tiles.map((tile) => (
            <StatTile key={tile.label} label={tile.label} value={tile.value} hint={tile.hint} tone={tile.tone} />
          ))}
        </div>
      ) : null}

      <Card title="Quick actions">
        <div className="flex flex-wrap gap-2">
          {can(PERMISSIONS.ENROLLMENT_CREATE) ? <LinkButton href="/enrollment/new">New application</LinkButton> : null}
          {can(PERMISSIONS.ENROLLMENT_VIEW) ? (
            <LinkButton href="/enrollment" variant="secondary">
              Review applications
            </LinkButton>
          ) : null}
          {can(PERMISSIONS.FEE_COLLECT) ? (
            <LinkButton href="/fees/collect" variant="secondary">
              Collect fees
            </LinkButton>
          ) : null}
          {can(PERMISSIONS.PROMOTION_RUN) ? (
            <LinkButton href="/promotion" variant="secondary">
              Promote a batch
            </LinkButton>
          ) : null}
          <LinkButton href="/reports" variant="secondary">
            Reports
          </LinkButton>
        </div>
      </Card>
    </>
  );
}
