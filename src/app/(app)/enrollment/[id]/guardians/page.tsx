import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { Alert, Badge, Card, TableWrap, Td, Th, Tr } from "@/components/ui";
import { GuardianEditor, GuardianRowActions } from "./guardian-editor";
import { StepFooter } from "../step-footer";

export const metadata = { title: "Guardians" };

export default async function GuardiansPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission(PERMISSIONS.ENROLLMENT_VIEW);
  const { id } = await params;

  const application = await prisma.application.findUnique({
    where: { id },
    include: { guardians: { orderBy: [{ isPrimary: "desc" }, { relation: "asc" }] } },
  });
  if (!application) notFound();

  // Enrolled is included on purpose: a parent's phone number is what reminders
  // and follow-up calls go to, so it stays correctable after admission.
  const editable = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "ENROLLED"].includes(application.status);

  return (
    <div className="space-y-4">
      {application.guardians.length === 0 ? (
        <Alert tone="warning" title="At least one guardian is required">
          Father, mother or guardian — at least one must be recorded before this application can be submitted.
        </Alert>
      ) : null}

      <Card
        title="Parent / guardian details"
        actions={editable ? <GuardianEditor applicationId={id} /> : null}
      >
        <TableWrap>
          <thead>
            <tr>
              <Th>Relationship</Th>
              <Th>Name</Th>
              <Th>Occupation</Th>
              <Th>Phone</Th>
              <Th>Email</Th>
              {editable ? <Th className="w-36" /> : null}
            </tr>
          </thead>
          <tbody>
            {application.guardians.length === 0 ? (
              <tr>
                <Td colSpan={editable ? 6 : 5} className="text-center text-muted">
                  No guardians recorded yet.
                </Td>
              </tr>
            ) : (
              application.guardians.map((guardian) => (
                <Tr key={guardian.id}>
                  <Td>
                    <div className="flex items-center gap-2">
                      {guardian.relation.charAt(0) + guardian.relation.slice(1).toLowerCase()}
                      {guardian.isPrimary ? <Badge tone="info">Primary contact</Badge> : null}
                    </div>
                  </Td>
                  <Td className="font-medium">{guardian.name}</Td>
                  <Td>{guardian.occupation ?? "—"}</Td>
                  <Td>{guardian.phone ?? "—"}</Td>
                  <Td>{guardian.email ?? "—"}</Td>
                  {editable ? (
                    <Td>
                      <GuardianRowActions
                        applicationId={id}
                        guardian={{
                          id: guardian.id,
                          relation: guardian.relation,
                          name: guardian.name,
                          occupation: guardian.occupation,
                          phone: guardian.phone,
                          email: guardian.email,
                          isPrimary: guardian.isPrimary,
                        }}
                      />
                    </Td>
                  ) : null}
                </Tr>
              ))
            )}
          </tbody>
        </TableWrap>
      </Card>

      <StepFooter
        back={{ href: `/enrollment/${id}/edit`, label: "Back to student information" }}
        next={{ href: `/enrollment/${id}/course`, label: "Continue to course selection" }}
      />
    </div>
  );
}
