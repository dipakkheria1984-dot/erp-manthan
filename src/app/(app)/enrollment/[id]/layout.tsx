import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { APPLICATION_STATUS_TONE, statusLabel } from "@/lib/enrollment";
import { Badge } from "@/components/ui";
import { SubNav } from "@/components/sub-nav";

export default async function ApplicationLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  await requirePermission(PERMISSIONS.ENROLLMENT_VIEW);
  const { id } = await params;

  const application = await prisma.application.findUnique({
    where: { id },
    select: { id: true, fullName: true, applicationNo: true, status: true, studentCode: true, isProvisional: true },
  });
  if (!application) notFound();

  const base = `/enrollment/${id}`;
  const tabs = [
    { label: "Overview", href: base },
    { label: "1. Student", href: `${base}/edit` },
    { label: "2. Guardians", href: `${base}/guardians` },
    { label: "3. Course", href: `${base}/course` },
    { label: "4. Documents", href: `${base}/documents` },
    { label: "5. Fee plan", href: `${base}/fee-plan` },
    { label: "6. Registration fee", href: `${base}/fee` },
    { label: "7. Review & decision", href: `${base}/review` },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{application.fullName}</h1>
        <Badge tone={APPLICATION_STATUS_TONE[application.status]}>{statusLabel(application.status)}</Badge>
        {application.applicationNo ? (
          <span className="font-mono text-sm text-muted">{application.applicationNo}</span>
        ) : null}
        {application.studentCode ? <Badge tone="success">{application.studentCode}</Badge> : null}
        {application.isProvisional ? (
          <Badge tone="warning">Provisional</Badge>
        ) : application.status === "ENROLLED" ? (
          <Badge tone="success">Confirmed</Badge>
        ) : null}
      </div>
      <SubNav tabs={tabs} />
      {children}
    </div>
  );
}
