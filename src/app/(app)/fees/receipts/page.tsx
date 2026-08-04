import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getInstitute } from "@/lib/config";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { endOfDay, formatDate, formatDateTime, fromDateInput } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { Alert, Badge, Card, LinkButton, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { EmailDocumentButton } from "@/components/email-document-button";
import { ReceiptFilters } from "./receipt-filters";
import { CancelReceiptButton } from "./cancel-receipt-button";
import type { PaymentStatus } from "@/generated/prisma/client";

export const metadata = { title: "Receipts" };

const PAGE_SIZE = 30;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

export default async function ReceiptsPage({ searchParams }: { searchParams: SearchParams }) {
  const actor = await requirePermission(PERMISSIONS.FEE_COLLECT, PERMISSIONS.FEE_CANCEL_RECEIPT);
  const canCancel = hasPermission(actor.permissions, PERMISSIONS.FEE_CANCEL_RECEIPT);
  const params = await searchParams;

  const q = one(params.q);
  const status = one(params.status);
  const from = one(params.from);
  const to = one(params.to);
  const page = Math.max(1, Number.parseInt(one(params.page) || "1", 10) || 1);

  const where = {
    ...(status ? { status: status as PaymentStatus } : {}),
    ...(q
      ? {
          OR: [
            { receiptNo: { contains: q, mode: "insensitive" as const } },
            { referenceNo: { contains: q, mode: "insensitive" as const } },
            { student: { studentCode: { contains: q, mode: "insensitive" as const } } },
            { student: { fullName: { contains: q, mode: "insensitive" as const } } },
            { application: { fullName: { contains: q, mode: "insensitive" as const } } },
          ],
        }
      : {}),
    ...(from || to
      ? {
          paymentDate: {
            ...(from ? { gte: fromDateInput(from) } : {}),
            ...(to ? { lte: endOfDay(fromDateInput(to)) } : {}),
          },
        }
      : {}),
  };

  // A receipt can hold several allocation rows (one collection spread across
  // installments), so the list pages over receipt numbers, not over rows.
  const [receiptPage, allReceipts] = await Promise.all([
    prisma.payment.groupBy({
      by: ["receiptNo"],
      where,
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: "desc" } },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
    }),
    prisma.payment.findMany({ where, distinct: ["receiptNo"], select: { receiptNo: true } }),
  ]);
  const total = allReceipts.length;

  const institute = await getInstitute().catch(() => null);

  const lines = await prisma.payment.findMany({
    where: { receiptNo: { in: receiptPage.map((group) => group.receiptNo) } },
    include: {
      student: { select: { id: true, studentCode: true, fullName: true, email: true } },
      application: { select: { id: true, applicationNo: true, fullName: true, email: true } },
      collectedBy: { select: { name: true } },
      cancelledBy: { select: { name: true } },
      installment: { select: { seqNo: true, feeAssignment: { select: { semester: { select: { semesterNumber: true } } } } } },
    },
    orderBy: { receiptSeq: "asc" },
  });

  const receipts = receiptPage.map((group) => {
    const rows = lines.filter((line) => line.receiptNo === group.receiptNo);
    const head = rows[0];
    return {
      receiptNo: group.receiptNo,
      head,
      rows,
      amountPaise: rows.reduce((sum, row) => sum + row.amountPaise, 0),
      lateFeePaise: rows.reduce((sum, row) => sum + row.lateFeePortionPaise, 0),
    };
  });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageHref = (next: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, status, from, to })) if (v) sp.set(k, v);
    sp.set("page", String(next));
    return `/fees/receipts?${sp.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Receipts"
        description="Every money-in transaction, including cancelled ones. Cancelled receipts keep their number so the sequence stays intact."
      />

      <div className="space-y-4">
        <Card>
          <ReceiptFilters defaults={{ q, status, from, to }} />
        </Card>

        {canCancel ? (
          <Alert tone="info" title="Cancelling a receipt">
            Only an Admin can void a receipt, a reason is mandatory, and there is no time limit. Voided receipts are
            excluded from Fee Collection totals but remain visible in the Student Ledger as an audit entry.
          </Alert>
        ) : null}

        <Card title={`${total.toLocaleString("en-IN")} receipt${total === 1 ? "" : "s"}`}>
          <TableWrap>
            <thead>
              <tr>
                <Th>Receipt</Th>
                <Th>Date</Th>
                <Th>Student / applicant</Th>
                <Th>Particulars</Th>
                <Th className="text-right">Amount</Th>
                <Th>Mode</Th>
                <Th>Collected by</Th>
                <Th>Status</Th>
                <Th className="w-40" />
              </tr>
            </thead>
            <tbody>
              {receipts.length === 0 ? (
                <tr>
                  <Td colSpan={9} className="text-center text-muted">
                    No receipts match these filters.
                  </Td>
                </tr>
              ) : (
                receipts.map(({ receiptNo, head, rows, amountPaise, lateFeePaise }) => {
                  if (!head) return null;
                  return (
                    <Tr key={receiptNo} className={head.status === "CANCELLED" ? "opacity-70" : undefined}>
                      <Td>
                        <a
                          href={`/api/receipts/${receiptNo}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs text-brand hover:underline"
                        >
                          {receiptNo}
                        </a>
                      </Td>
                      <Td className="whitespace-nowrap">{formatDate(head.paymentDate)}</Td>
                      <Td>
                        {head.student ? (
                          <Link href={`/students/${head.student.id}`} className="text-brand hover:underline">
                            {head.student.fullName}
                          </Link>
                        ) : (
                          (head.application?.fullName ?? "—")
                        )}
                        <p className="text-xs text-muted">
                          {head.student?.studentCode ?? head.application?.applicationNo ?? ""}
                        </p>
                      </Td>
                      <Td className="text-muted">
                        {head.kind === "REGISTRATION"
                          ? "Registration fee"
                          : rows
                              .map(
                                (row) =>
                                  `Sem ${row.installment?.feeAssignment.semester.semesterNumber ?? "—"} · inst ${
                                    row.installment?.seqNo ?? "—"
                                  } ${formatPaise(row.amountPaise)}`,
                              )
                              .join(" · ")}
                        {lateFeePaise > 0 ? <p className="text-xs">incl. {formatPaise(lateFeePaise)} late fee</p> : null}
                      </Td>
                      <Td className="text-right tabular-nums">
                        <span className={head.status === "CANCELLED" ? "line-through" : undefined}>
                          {formatPaise(amountPaise)}
                        </span>
                      </Td>
                      <Td>{head.mode.replaceAll("_", " ").toLowerCase()}</Td>
                      <Td className="text-muted">{head.collectedBy?.name ?? "—"}</Td>
                      <Td>
                        {head.status === "ACTIVE" ? (
                          <Badge tone="success">Active</Badge>
                        ) : (
                          <>
                            <Badge tone="danger">Cancelled</Badge>
                            <p className="mt-1 text-xs text-muted">
                              {head.cancelledBy?.name} · {formatDateTime(head.cancelledAt)}
                            </p>
                            <p className="text-xs text-muted">{head.cancellationReason}</p>
                          </>
                        )}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap items-center gap-2">
                          <EmailDocumentButton
                            target={{ kind: "receipt", receiptId: receiptNo }}
                            size="sm"
                            variant="ghost"
                            label="Email"
                            defaultTo={head.student?.email ?? head.application?.email ?? null}
                            defaultSubject={`Fee receipt ${receiptNo}${institute ? ` — ${institute.name}` : ""}`}
                            defaultMessage={
                              `Dear ${head.student?.fullName ?? head.application?.fullName ?? "student"},\n\n` +
                              `Please find attached fee receipt ${receiptNo}.\n\n` +
                              "Keep it safe — it is the proof of payment the institute recognises." +
                              (institute ? `\n\n— ${institute.name}` : "")
                            }
                          />
                          {canCancel && head.status === "ACTIVE" ? (
                            <CancelReceiptButton paymentId={head.id} receiptNo={receiptNo} />
                          ) : null}
                        </div>
                      </Td>
                    </Tr>
                  );
                })
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
