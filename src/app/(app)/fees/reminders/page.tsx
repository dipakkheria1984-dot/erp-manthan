import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { getConfig, getCommunicationConfig } from "@/lib/config";
import { PERMISSIONS } from "@/lib/permissions";
import { formatDateTime } from "@/lib/dates";
import { MAX_DELIVERY_ATTEMPTS } from "@/lib/notifications";
import { countAwaitingRetry } from "@/lib/notification-retry";
import { Alert, Badge, Card, PageHeader, StatTile, TableWrap, Td, Th, Tr } from "@/components/ui";
import { RecalculateButton, RetryAllButton, RetryOneButton, RunRemindersButton } from "./reminder-controls";

export const metadata = { title: "Reminders" };

/**
 * What happens to a failed delivery next, in the terms the office cares about.
 *
 * The distinction that matters on this list is between a message still on its
 * way and one that has stopped — and, when it has stopped, whether pressing
 * Retry would achieve anything at all.
 */
function retryNote(log: {
  nextAttemptAt: Date | null;
  retryable: boolean;
  recipient: string;
}): string {
  if (log.nextAttemptAt) return `next try ${formatDateTime(log.nextAttemptAt)}`;
  if (!log.recipient) return "no address on file";
  // An email whose point was its attachment: the log kept the covering note but
  // not the document, so it goes again from the screen that produced it.
  if (!log.retryable) return "resend from the student's screen";
  return "no automatic tries left";
}

export default async function RemindersPage() {
  await requirePermission(PERMISSIONS.INSTITUTE_MANAGE);

  const [config, comms, lastRun, failures, recent, failureCount, awaitingRetry] = await Promise.all([
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
    countAwaitingRetry(),
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
            hint={
              awaitingRetry > 0
                ? `${awaitingRetry} waiting on an automatic retry`
                : failureCount > 0
                  ? "Needs attention"
                  : "All delivered"
            }
          />
        </div>

        <Card
          title="Scheduling"
          description="Point a scheduler at the job endpoint once a day, or run it by hand with the button above."
        >
          <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 text-xs">
            {`curl -X POST -H "x-job-secret: $JOB_SECRET" https://your-host/api/jobs/reminders\ncurl -X POST -H "x-job-secret: $JOB_SECRET" https://your-host/api/jobs/notification-retry`}
          </pre>
          <p className="mt-2 text-sm text-muted">
            Locally: <code className="font-mono">npm run job:reminders</code>. The pass is idempotent — a pre-due
            reminder goes out once per installment and an overdue reminder only after the configured interval has
            elapsed, so running it more than once a day is harmless.
          </p>
          <p className="mt-2 text-sm text-muted">
            The second endpoint is the retry sweep, and wants to run every half hour rather than daily — a message
            that failed at 3am is owed its second try at 3.30, not tomorrow. It does nothing at all when there is
            nothing outstanding.
          </p>
        </Card>

        {failures.length > 0 ? (
          <Card
            title="Failed deliveries"
            description={`Bounced emails and refused WhatsApp messages, flagged for Admin. Each is tried again automatically after 30 minutes, up to ${MAX_DELIVERY_ATTEMPTS} attempts in all — retry sooner if you have just put right whatever was wrong.`}
            actions={<RetryAllButton />}
          >
            <TableWrap>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Student</Th>
                  <Th>Channel</Th>
                  <Th>Recipient</Th>
                  <Th>Error</Th>
                  <Th>Tries</Th>
                  <Th>
                    <span className="sr-only">Retry</span>
                  </Th>
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
                    <Td className="whitespace-nowrap text-xs text-muted">
                      {log.attempts} of {MAX_DELIVERY_ATTEMPTS}
                      <span className="block">{retryNote(log)}</span>
                    </Td>
                    <Td>
                      {log.retryable && log.recipient ? <RetryOneButton logId={log.id} /> : null}
                    </Td>
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
