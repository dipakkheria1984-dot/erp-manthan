import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getConfig, getCommunicationConfig } from "@/lib/config";
import { PERMISSIONS } from "@/lib/permissions";
import { formatDateTime } from "@/lib/dates";
import { Alert, Badge, Card, PageHeader, StatTile, TableWrap, Td, Th, Tr } from "@/components/ui";
import { RecalculateButton, RunRemindersButton } from "./reminder-controls";

export const metadata = { title: "Reminders" };

export default async function RemindersPage() {
  await requirePermission(PERMISSIONS.INSTITUTE_MANAGE);

  const [config, comms, lastRun, failures, recent, failureCount] = await Promise.all([
    getConfig(),
    getCommunicationConfig(),
    prisma.reminderRun.findFirst({ orderBy: { runAt: "desc" } }),
    prisma.notificationLog.findMany({
      where: { status: "FAILED", acknowledgedAt: null },
      include: { student: { select: { studentCode: true, fullName: true } } },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    prisma.notificationLog.findMany({
      include: { student: { select: { studentCode: true } } },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
    prisma.notificationLog.count({ where: { status: "FAILED" } }),
  ]);

  const usingMock = comms.emailProvider === "mock" || (comms.whatsappProvider ?? "mock") === "mock";

  return (
    <>
      <PageHeader
        title="Fee reminders"
        description="Email and WhatsApp are always sent together for every reminder — this is not configurable per student."
        actions={
          <>
            <RecalculateButton />
            <RunRemindersButton />
          </>
        }
      />

      <div className="space-y-6">
        {usingMock ? (
          <Alert tone="info" title="Running in log-only mode">
            {comms.emailProvider === "mock" ? "Email" : ""}
            {comms.emailProvider === "mock" && (comms.whatsappProvider ?? "mock") === "mock" ? " and " : ""}
            {(comms.whatsappProvider ?? "mock") === "mock" ? "WhatsApp" : ""} messages are written to the log instead of
            being delivered. Configure a real provider in Institute Setup → Communication when credentials are ready —
            nothing else needs to change.
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Pre-due reminder" value={`${config.preDueReminderDays} days before`} />
          <StatTile label="Overdue repeat" value={`every ${config.overdueReminderIntervalDays} days`} />
          <StatTile label="Last run" value={lastRun ? formatDateTime(lastRun.runAt) : "Never"} />
          <StatTile
            label="Delivery failures"
            value={failureCount}
            tone={failureCount > 0 ? "danger" : "success"}
            hint={failureCount > 0 ? "Needs attention" : "All delivered"}
          />
        </div>

        <Card
          title="Scheduling"
          description="Point a scheduler at the job endpoint once a day, or run it by hand with the button above."
        >
          <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 text-xs">
            {`curl -X POST -H "x-job-secret: $JOB_SECRET" https://your-host/api/jobs/reminders`}
          </pre>
          <p className="mt-2 text-sm text-muted">
            Locally: <code className="font-mono">npm run job:reminders</code>. The pass is idempotent — a pre-due
            reminder goes out once per installment and an overdue reminder only after the configured interval has
            elapsed, so running it more than once a day is harmless.
          </p>
        </Card>

        {failures.length > 0 ? (
          <Card title="Failed deliveries" description="Bounced emails and invalid WhatsApp numbers, flagged for Admin.">
            <TableWrap>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Student</Th>
                  <Th>Channel</Th>
                  <Th>Recipient</Th>
                  <Th>Error</Th>
                </tr>
              </thead>
              <tbody>
                {failures.map((log) => (
                  <Tr key={log.id}>
                    <Td className="whitespace-nowrap text-muted">{formatDateTime(log.createdAt)}</Td>
                    <Td>{log.student ? `${log.student.studentCode} — ${log.student.fullName}` : "—"}</Td>
                    <Td>
                      <Badge tone="neutral">{log.channel.toLowerCase()}</Badge>
                    </Td>
                    <Td className="font-mono text-xs">{log.recipient || "(none on file)"}</Td>
                    <Td className="text-danger">{log.error}</Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>
        ) : null}

        <Card title="Recent notifications">
          <TableWrap>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Kind</Th>
                <Th>Channel</Th>
                <Th>Student</Th>
                <Th>Recipient</Th>
                <Th>Subject</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <Td colSpan={7} className="text-center text-muted">
                    Nothing sent yet.
                  </Td>
                </tr>
              ) : (
                recent.map((log) => (
                  <Tr key={log.id}>
                    <Td className="whitespace-nowrap text-muted">{formatDateTime(log.createdAt)}</Td>
                    <Td className="text-xs">{log.kind.replaceAll("_", " ").toLowerCase()}</Td>
                    <Td className="text-xs">{log.channel.toLowerCase()}</Td>
                    <Td className="font-mono text-xs">{log.student?.studentCode ?? "—"}</Td>
                    <Td className="font-mono text-xs">{log.recipient || "—"}</Td>
                    <Td className="max-w-xs truncate">{log.subject ?? "—"}</Td>
                    <Td>
                      <Badge tone={log.status === "SENT" ? "success" : log.status === "FAILED" ? "danger" : "neutral"}>
                        {log.status.toLowerCase()}
                      </Badge>
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </TableWrap>
        </Card>
      </div>
    </>
  );
}
