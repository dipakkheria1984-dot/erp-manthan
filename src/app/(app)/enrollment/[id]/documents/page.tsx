import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { formatDateTime } from "@/lib/dates";
import { env } from "@/lib/env";
import { Badge, Card, TableWrap, Td, Th, Tr } from "@/components/ui";
import { DocumentUpload, DocumentVerification } from "./document-forms";
import { StepFooter } from "../step-footer";

export const metadata = { title: "Documents" };

const DOC_TONE = { PENDING: "warning", VERIFIED: "success", REJECTED: "danger" } as const;

export default async function DocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(PERMISSIONS.ENROLLMENT_VIEW);
  const { id } = await params;

  const [application, requirements] = await Promise.all([
    prisma.application.findUnique({
      where: { id },
      include: { documents: { include: { verifiedBy: { select: { name: true } } } } },
    }),
    prisma.documentRequirement.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
  ]);
  if (!application) notFound();

  const canUpload =
    hasPermission(actor.permissions, PERMISSIONS.ENROLLMENT_CREATE) &&
    ["DRAFT", "SUBMITTED", "UNDER_REVIEW"].includes(application.status);
  const canVerify = hasPermission(actor.permissions, PERMISSIONS.ENROLLMENT_VERIFY_DOCUMENTS);

  const byCode = new Map(application.documents.map((doc) => [doc.requirementCode, doc]));

  return (
    <div className="space-y-4">
      <Card
        title="Document checklist"
        description={`Uploads are optional — an application can be submitted and approved with nothing on file, and anything marked expected can be collected later. PDF, JPG or PNG up to ${env.maxUploadMb} MB each. Re-uploading a document replaces the previous file and resets its verification.`}
      >
        <TableWrap>
          <thead>
            <tr>
              <Th>Document</Th>
              <Th>Collection</Th>
              <Th>File</Th>
              <Th>Status</Th>
              <Th>Verified by</Th>
              <Th className="w-72" />
            </tr>
          </thead>
          <tbody>
            {requirements.map((requirement) => {
              const doc = byCode.get(requirement.code);
              return (
                <Tr key={requirement.id}>
                  <Td className="font-medium">{requirement.label}</Td>
                  <Td>{requirement.isRequired ? <Badge tone="warning">Expected</Badge> : <Badge>Optional</Badge>}</Td>
                  <Td>
                    {doc ? (
                      <a
                        href={`/api/documents/${doc.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brand hover:underline"
                      >
                        {doc.fileName}
                      </a>
                    ) : (
                      <span className="text-muted">Not uploaded</span>
                    )}
                    {doc?.remarks ? <p className="text-xs text-danger">{doc.remarks}</p> : null}
                  </Td>
                  <Td>{doc ? <Badge tone={DOC_TONE[doc.status]}>{doc.status.toLowerCase()}</Badge> : "—"}</Td>
                  <Td className="text-muted">
                    {doc?.verifiedBy?.name ?? "—"}
                    {doc?.verifiedAt ? <p className="text-xs">{formatDateTime(doc.verifiedAt)}</p> : null}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      {canUpload ? (
                        <DocumentUpload applicationId={id} requirementCode={requirement.code} hasFile={Boolean(doc)} />
                      ) : null}
                      {canVerify && doc ? <DocumentVerification documentId={doc.id} /> : null}
                    </div>
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </TableWrap>
      </Card>

      <StepFooter
        back={{ href: `/enrollment/${id}/course`, label: "Back to course selection" }}
        next={{ href: `/enrollment/${id}/fee-plan`, label: "Continue to fee plan" }}
      />
    </div>
  );
}
