import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { applicationForToken } from "@/lib/applicant-portal";
import { Alert, Badge, Card, EmptyState, LinkButton, TableWrap, Td, Th, Tr } from "@/components/ui";
import { PortalDocumentUpload } from "./upload-form";

export default async function PortalDocumentsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await applicationForToken(token);
  if (!result.ok) notFound();

  const [requirements, documents] = await Promise.all([
    prisma.documentRequirement.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.applicationDocument.findMany({ where: { applicationId: result.application.id } }),
  ]);

  const byCode = new Map(documents.map((document) => [document.requirementCode, document]));

  return (
    <div className="space-y-6">
      <Alert tone="info" title="Uploading now is optional">
        Upload a clear scan or photo of each document if you can — PDF, JPG or PNG — and you can replace a
        file any time before you finish. If you are not able to, send your form in anyway and bring a
        physical copy of anything missing to the admissions office once your admission is confirmed.
      </Alert>

      <Card title="Your documents">
        {requirements.length === 0 ? (
          <EmptyState title="No documents are being asked for." />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>Document</Th>
                <Th>Uploaded</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {requirements.map((requirement) => {
                const document = byCode.get(requirement.code);
                return (
                  <Tr key={requirement.id}>
                    <Td>
                      {requirement.label}{" "}
                      {requirement.isRequired ? (
                        <Badge tone="warning">Required</Badge>
                      ) : (
                        <Badge>Optional</Badge>
                      )}
                    </Td>
                    <Td>
                      {document ? (
                        <span className="text-sm">{document.fileName}</span>
                      ) : (
                        <span className="text-sm text-muted">Not uploaded</span>
                      )}
                    </Td>
                    <Td>
                      <PortalDocumentUpload
                        token={token}
                        requirementCode={requirement.code}
                        hasFile={Boolean(document)}
                      />
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <div className="flex justify-end">
        <LinkButton href={`/apply/${token}/payment`}>Continue to registration fee</LinkButton>
      </div>
    </div>
  );
}
