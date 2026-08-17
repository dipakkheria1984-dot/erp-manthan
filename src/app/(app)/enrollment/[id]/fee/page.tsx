import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { requiredRegistrationFee } from "@/lib/enrollment";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { formatDate } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { Alert, Badge, Card, StatTile, TableWrap, Td, Th, Tr } from "@/components/ui";
import { RegistrationFeeForm } from "./registration-fee-form";
import { StepFooter } from "../step-footer";

export const metadata = { title: "Registration fee" };

export default async function RegistrationFeePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(PERMISSIONS.ENROLLMENT_VIEW);
  const { id } = await params;

  const [application, config] = await Promise.all([
    prisma.application.findUnique({
      where: { id },
      include: {
        feePlan: { orderBy: { seqNo: "asc" } },
        payments: {
          where: { kind: "REGISTRATION" },
          include: { collectedBy: { select: { name: true } } },
          orderBy: { paymentDate: "desc" },
        },
      },
    }),
    getConfig(),
  ]);
  if (!application) notFound();

  const canRecord =
    hasPermission(actor.permissions, PERMISSIONS.FEE_COLLECT) ||
    hasPermission(actor.permissions, PERMISSIONS.ENROLLMENT_CREATE);

  const paid = application.registrationFeePaidPaise;
  // The batch's registration fee, not the institute floor.
  const required = await requiredRegistrationFee(application);
  const shortfall = Math.max(0, required - paid);
  const firstInstallment = application.feePlan[0];
  const roomLeft = firstInstallment ? Math.max(0, firstInstallment.amountPaise - paid) : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Registration fee"
          value={formatPaise(required)}
          hint="Set on the batch · gates Draft → Submitted"
        />
        <StatTile label="Collected" value={formatPaise(paid)} tone={shortfall === 0 ? "success" : "default"} />
        <StatTile
          label="Shortfall"
          value={formatPaise(shortfall)}
          tone={shortfall > 0 ? "danger" : "success"}
          hint={shortfall > 0 ? "Application cannot be submitted yet" : "Threshold met"}
        />
      </div>

      {application.claimedPaymentReference ? (
        <Alert
          tone={application.claimedPaymentSettledAt ? "success" : "warning"}
          title={
            application.claimedPaymentSettledAt
              ? "Online payment — already checked"
              : "Online payment reported — not verified"
          }
        >
          The applicant says they paid{" "}
          <strong>{formatPaise(application.claimedPaymentPaise ?? 0)}</strong> on{" "}
          {formatDate(application.claimedPaymentAt)} with reference{" "}
          <span className="font-mono">{application.claimedPaymentReference}</span>.
          {application.claimedPaymentSettledAt ? null : (
            <>
              {" "}
              The bank&rsquo;s page reports nothing back to this system, so this is their word and nothing more —
              no receipt exists and nothing has moved. Check it against the bank statement, then record it below
              like any other collection. Recording it is what issues the receipt and clears the provisional
              admission.
            </>
          )}
        </Alert>
      ) : null}

      {firstInstallment ? (
        <Alert tone="info">
          Partial payments are accepted — the application can be submitted as soon as the total collected reaches the
          minimum. This money is <strong>part of the total fee</strong>, not an extra charge: it settles installment 1
          of {formatPaise(firstInstallment.amountPaise)} (due {formatDate(firstInstallment.dueDate)}), leaving{" "}
          {formatPaise(roomLeft)} of that installment collectable here.
        </Alert>
      ) : (
        <Alert tone="warning" title="Enter the fee plan first">
          The installment amounts and due dates are fixed before any fee is collected. Go to step 5 — Fee plan — and
          save the schedule, then come back to record the registration fee.
        </Alert>
      )}

      {canRecord && application.status !== "REJECTED" && firstInstallment ? (
        <Card title="Record a registration fee payment">
          <RegistrationFeeForm applicationId={id} />
        </Card>
      ) : null}

      <Card title="Payments received">
        <TableWrap>
          <thead>
            <tr>
              <Th>Receipt</Th>
              <Th>Date</Th>
              <Th className="text-right">Amount</Th>
              <Th>Mode</Th>
              <Th>Reference</Th>
              <Th>Collected by</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {application.payments.length === 0 ? (
              <tr>
                <Td colSpan={7} className="text-center text-muted">
                  No registration fee recorded yet.
                </Td>
              </tr>
            ) : (
              application.payments.map((payment) => (
                <Tr key={payment.id}>
                  <Td className="font-mono text-xs">{payment.receiptNo}</Td>
                  <Td className="whitespace-nowrap">{formatDate(payment.paymentDate)}</Td>
                  <Td className="text-right tabular-nums">{formatPaise(payment.amountPaise)}</Td>
                  <Td>{payment.mode.replaceAll("_", " ").toLowerCase()}</Td>
                  <Td className="text-muted">{payment.referenceNo ?? "—"}</Td>
                  <Td className="text-muted">{payment.collectedBy?.name ?? "—"}</Td>
                  <Td>
                    {payment.status === "ACTIVE" ? (
                      <Badge tone="success">Active</Badge>
                    ) : (
                      <Badge tone="danger">Cancelled</Badge>
                    )}
                  </Td>
                </Tr>
              ))
            )}
          </tbody>
        </TableWrap>
      </Card>

      <StepFooter
        back={{ href: `/enrollment/${id}/fee-plan`, label: "Back to fee plan" }}
        next={{
          href: `/enrollment/${id}/review`,
          label: application.status === "DRAFT" ? "Continue to review & submit" : "Continue to review & decision",
        }}
      />
    </div>
  );
}
