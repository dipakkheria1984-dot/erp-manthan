import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { formatDateTime } from "@/lib/dates";
import { endOfDay, fromDateInput } from "@/lib/dates";
import { Badge, Card, LinkButton, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { AuditFilters } from "./audit-filters";

export const metadata = { title: "Audit trail" };

const PAGE_SIZE = 50;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePermission(PERMISSIONS.AUDIT_VIEW);
  const params = await searchParams;

  const userId = one(params.userId);
  const action = one(params.action);
  const from = one(params.from);
  const to = one(params.to);
  const page = Math.max(1, Number.parseInt(one(params.page) || "1", 10) || 1);

  const where = {
    ...(userId ? { userId } : {}),
    ...(action ? { action: { contains: action, mode: "insensitive" as const } } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: fromDateInput(from) } : {}),
            ...(to ? { lte: endOfDay(fromDateInput(to)) } : {}),
          },
        }
      : {}),
  };

  const [logs, total, users] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
    prisma.auditLog.count({ where }),
    prisma.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (nextPage: number) => {
    const sp = new URLSearchParams();
    if (userId) sp.set("userId", userId);
    if (action) sp.set("action", action);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    sp.set("page", String(nextPage));
    return `/users/audit?${sp.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every sign-in, record change, approval and status change is logged with the acting user, timestamp and — where the spec requires one — a written reason."
      />

      <div className="space-y-4">
        <Card>
          <AuditFilters users={users} defaults={{ userId, action, from, to }} />
        </Card>

        <Card
          title={`${total.toLocaleString("en-IN")} event${total === 1 ? "" : "s"}`}
          description={`Page ${page} of ${totalPages}`}
        >
          <TableWrap>
            <thead>
              <tr>
                <Th className="w-44">When</Th>
                <Th className="w-40">User</Th>
                <Th className="w-52">Action</Th>
                <Th>Summary</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <Td colSpan={5} className="text-center text-muted">
                    No matching audit events.
                  </Td>
                </tr>
              ) : (
                logs.map((log) => (
                  <Tr key={log.id}>
                    <Td className="whitespace-nowrap text-muted">{formatDateTime(log.createdAt)}</Td>
                    <Td>{log.user?.name ?? "System"}</Td>
                    <Td>
                      <Badge tone={log.action.includes("failed") ? "danger" : "neutral"}>{log.action}</Badge>
                    </Td>
                    <Td>{log.summary}</Td>
                    <Td className="max-w-sm text-muted">{log.reason ?? "—"}</Td>
                  </Tr>
                ))
              )}
            </tbody>
          </TableWrap>

          {totalPages > 1 ? (
            <div className="mt-4 flex items-center justify-between">
              <LinkButton href={qs(page - 1)} variant="secondary" size="sm" aria-disabled={page <= 1}>
                Previous
              </LinkButton>
              <span className="text-sm text-muted">
                Page {page} of {totalPages}
              </span>
              <LinkButton href={qs(page + 1)} variant="secondary" size="sm" aria-disabled={page >= totalPages}>
                Next
              </LinkButton>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
