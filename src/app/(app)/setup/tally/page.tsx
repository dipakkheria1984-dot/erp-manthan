import { env } from "@/lib/env";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { formatDateTime, toDateInput } from "@/lib/dates";
import { getTallyConfig, recentTallyRows, tallyQueueSummary } from "@/lib/tally/outbox";
import { Alert, Badge, Card, PageHeader, StatTile, TableWrap, Td, Th, Tr, type BadgeTone } from "@/components/ui";
import { RetryFailedButton, TallyConfigForm } from "./tally-config-form";

export const metadata = { title: "Tally Prime · Setup" };
export const dynamic = "force-dynamic";

/** The bridge polls every ~20 seconds; two minutes of silence means it is not running. */
const BRIDGE_STALE_MS = 2 * 60_000;

const STATUS_TONE: Record<string, BadgeTone> = {
  PENDING: "info",
  IN_FLIGHT: "info",
  SYNCED: "success",
  FAILED: "danger",
  SKIPPED: "neutral",
};

export default async function TallySetupPage() {
  // The setup area also admits T&C managers; ledger mapping is for admins only.
  await requirePermission(PERMISSIONS.INSTITUTE_MANAGE);
  const [config, counts, rows] = await Promise.all([getTallyConfig(), tallyQueueSummary(), recentTallyRows(50)]);

  const lastSeen = config.bridgeLastSeenAt;
  const bridgeOnline = lastSeen !== null && Date.now() - lastSeen.getTime() < BRIDGE_STALE_MS;

  return (
    <>
      <PageHeader
        title="Tally Prime connector"
        description="Every receipt taken by UPI, card, bank transfer, cheque or other is posted to Tally Prime as a Receipt voucher. Cancelling a receipt here cancels its voucher there. Vouchers are never deleted, so Tally's Edit Log keeps a complete history."
      />

      <div className="space-y-6">
        {!env.tallyBridgeKey ? (
          <Alert tone="warning" title="TALLY_BRIDGE_KEY is not set on this deployment">
            The bridge on the Tally PC cannot connect until it is. Add it to the environment variables and redeploy.
          </Alert>
        ) : null}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <StatTile
            label="Bridge"
            value={bridgeOnline ? (config.bridgeTallyOnline ? "Online" : "Tally closed") : "Offline"}
            tone={bridgeOnline ? (config.bridgeTallyOnline ? "success" : "warning") : "danger"}
            hint={lastSeen ? `Last seen ${formatDateTime(lastSeen)}` : "Never connected"}
          />
          <StatTile label="Waiting" value={counts.PENDING + counts.IN_FLIGHT} tone={counts.PENDING + counts.IN_FLIGHT > 0 ? "warning" : "default"} />
          <StatTile label="Posted" value={counts.SYNCED} tone="success" />
          <StatTile label="Failed" value={counts.FAILED} tone={counts.FAILED > 0 ? "danger" : "default"} />
          <StatTile label="Skipped" value={counts.SKIPPED} hint="Voided before posting" />
        </div>

        <Card title="Settings" description="Ledger and voucher type names must match Tally exactly, including spelling and capitalisation.">
          <TallyConfigForm
            config={{
              enabled: config.enabled,
              companyName: config.companyName ?? "",
              voucherTypeName: config.voucherTypeName,
              syncFrom: toDateInput(config.syncFrom),
              ledgerUpi: config.ledgerUpi ?? "",
              ledgerCard: config.ledgerCard ?? "",
              ledgerBankTransfer: config.ledgerBankTransfer ?? "",
              ledgerCheque: config.ledgerCheque ?? "",
              ledgerOther: config.ledgerOther ?? "",
              creditMode: config.creditMode,
              feeLedger: config.feeLedger,
              registrationLedger: config.registrationLedger,
              lateFeeLedger: config.lateFeeLedger ?? "",
              studentLedgerGroup: config.studentLedgerGroup,
              sendBankAllocations: config.sendBankAllocations,
            }}
          />
        </Card>

        <Card title="Recent activity" actions={<RetryFailedButton disabled={counts.FAILED === 0} />}>
          {rows.length === 0 ? (
            <p className="text-sm text-muted">Nothing has been queued for Tally yet.</p>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>Receipt</Th>
                  <Th>Action</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Attempts</Th>
                  <Th>Updated</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Tr key={row.id}>
                    <Td className="font-medium tabular-nums">{row.receiptNo}</Td>
                    <Td>{row.action === "CREATE" ? "Post" : "Cancel"}</Td>
                    <Td>
                      <Badge tone={STATUS_TONE[row.status]}>{row.status === "IN_FLIGHT" ? "SENDING" : row.status}</Badge>
                    </Td>
                    <Td className="text-right tabular-nums">{row.attempts}</Td>
                    <Td className="whitespace-nowrap text-muted">{formatDateTime(row.updatedAt)}</Td>
                    <Td className="max-w-md whitespace-normal text-xs text-muted">
                      {row.lastError ?? (row.tallyMasterId ? `Tally master ID ${row.tallyMasterId}` : "")}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
      </div>
    </>
  );
}
