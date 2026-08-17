import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { APPLICATION_STATUS_TONE, statusLabel } from "@/lib/enrollment";
import { formatDate, endOfDay, fromDateInput } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { Badge, Card, LinkButton, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { ApplicationFilters } from "./application-filters";
import type { ApplicationStatus } from "@/generated/prisma/client";

export const metadata = { title: "Applications" };

const PAGE_SIZE = 25;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function ApplicationsPage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await requirePermission(PERMISSIONS.ENROLLMENT_VIEW);
  const canCreate = hasPermission(actor.permissions, PERMISSIONS.ENROLLMENT_CREATE);
  const params = await searchParams;

  const q = one(params.q);
  const status = one(params.status);
  const batchId = one(params.batchId);
  const from = one(params.from);
  const to = one(params.to);
  const queue = one(params.queue);
  const page = Math.max(1, Number.parseInt(one(params.page) || "1", 10) || 1);

  const where = {
    ...(status ? { status: status as ApplicationStatus } : {}),
    ...(batchId ? { batchId } : {}),
    // An online form the applicant has finished stays DRAFT — submission is the
    // office's act, once the batch, fee plan and registration fee are set. This
    // is the list of the ones waiting for exactly that.
    ...(queue === "awaiting-fee"
      ? { source: "ONLINE" as const, status: "DRAFT" as const, applicantSubmittedAt: { not: null } }
      : {}),
    ...(queue === "online" ? { source: "ONLINE" as const } : {}),
    ...(q
      ? {
          OR: [
            { fullName: { contains: q, mode: "insensitive" as const } },
            { applicationNo: { contains: q, mode: "insensitive" as const } },
            { studentCode: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q } },
          ],
        }
      : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: fromDateInput(from) } : {}),
            ...(to ? { lte: endOfDay(fromDateInput(to)) } : {}),
          },
        }
      : {}),
  };

  const [applications, total, batches] = await Promise.all([
    prisma.application.findMany({
      where,
      include: { batch: true, course: true, department: true },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
    prisma.application.count({ where }),
    prisma.batch.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, code: true } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (next: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, status, batchId, from, to, queue })) if (v) sp.set(k, v);
    sp.set("page", String(next));
    return `/enrollment?${sp.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Applications"
        description="Draft → Submitted → Under Review → Approved / Rejected → Enrolled."
        actions={canCreate ? <LinkButton href="/enrollment/new">New application</LinkButton> : null}
      />

      <div className="space-y-4">
        <Card>
          <ApplicationFilters
            batches={batches.map((b) => ({ id: b.id, name: `${b.code} — ${b.name}` }))}
            defaults={{ q, status, batchId, from, to, queue }}
          />
        </Card>

        <Card title={`${total.toLocaleString("en-IN")} application${total === 1 ? "" : "s"}`}>
          <TableWrap>
            <thead>
              <tr>
                <Th>Application</Th>
                <Th>Applicant</Th>
                <Th>Batch</Th>
                <Th className="text-right">Registration paid</Th>
                <Th>Created</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {applications.length === 0 ? (
                <tr>
                  <Td colSpan={6} className="text-center text-muted">
                    No applications match these filters.
                  </Td>
                </tr>
              ) : (
                applications.map((application) => (
                  <Tr key={application.id}>
                    <Td>
                      <Link href={`/enrollment/${application.id}`} className="font-medium text-brand hover:underline">
                        {application.applicationNo ?? "Draft"}
                      </Link>
                      {application.studentCode ? (
                        <p className="text-xs text-muted">{application.studentCode}</p>
                      ) : null}
                    </Td>
                    <Td>
                      {application.fullName}
                      <p className="text-xs text-muted">{application.phone ?? application.email ?? "—"}</p>
                    </Td>
                    <Td>
                      {application.batch?.name ?? "—"}
                      <p className="text-xs text-muted">{application.course?.name ?? ""}</p>
                    </Td>
                    <Td className="text-right tabular-nums">{formatPaise(application.registrationFeePaidPaise)}</Td>
                    <Td className="whitespace-nowrap text-muted">{formatDate(application.createdAt)}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={APPLICATION_STATUS_TONE[application.status]}>
                          {statusLabel(application.status)}
                        </Badge>
                        {application.isProvisional ? (
                          <Badge tone="warning">Provisional</Badge>
                        ) : application.status === "ENROLLED" ? (
                          <Badge tone="success">Confirmed</Badge>
                        ) : null}
                        {application.scholarshipNeedsApproval ? <Badge tone="info">Discount approval</Badge> : null}
                        {application.source === "ONLINE" && application.applicantSubmittedAt ? (
                          <Badge tone="info">Awaiting fee assignment</Badge>
                        ) : application.source === "ONLINE" ? (
                          <Badge>Applicant filling in</Badge>
                        ) : null}
                      </div>
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </TableWrap>

          {totalPages > 1 ? (
            <div className="mt-4 flex items-center justify-between">
              <LinkButton href={pageHref(Math.max(1, page - 1))} variant="secondary" size="sm">
                Previous
              </LinkButton>
              <span className="text-sm text-muted">
                Page {page} of {totalPages}
              </span>
              <LinkButton href={pageHref(Math.min(totalPages, page + 1))} variant="secondary" size="sm">
                Next
              </LinkButton>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
