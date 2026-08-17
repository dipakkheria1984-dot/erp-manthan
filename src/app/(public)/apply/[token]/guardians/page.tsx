import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { applicationForToken } from "@/lib/applicant-portal";
import { Badge, Card, EmptyState, LinkButton, TableWrap, Td, Th, Tr } from "@/components/ui";
import { AddGuardian, GuardianRowActions, type GuardianView } from "./guardian-forms";

const RELATION_LABEL: Record<string, string> = {
  FATHER: "Father",
  MOTHER: "Mother",
  GUARDIAN: "Guardian",
};

export default async function PortalGuardiansPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await applicationForToken(token);
  if (!result.ok) notFound();

  const guardians = await prisma.guardian.findMany({
    where: { applicationId: result.application.id },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });

  return (
    <div className="space-y-6">
      <Card
        title="Parents and guardians"
        description="At least one is needed. The main contact is who we call and send fee reminders to."
      >
        {guardians.length === 0 ? (
          <EmptyState title="No one added yet." description="Add a parent or guardian using the form below." />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Relationship</Th>
                <Th>Phone</Th>
                <Th>Email</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {guardians.map((guardian) => (
                <Tr key={guardian.id}>
                  <Td>
                    {guardian.name}
                    {guardian.isPrimary ? (
                      <>
                        {" "}
                        <Badge tone="success">Main contact</Badge>
                      </>
                    ) : null}
                  </Td>
                  <Td>{RELATION_LABEL[guardian.relation] ?? guardian.relation}</Td>
                  <Td>{guardian.phone || "—"}</Td>
                  <Td>{guardian.email || "—"}</Td>
                  <Td>
                    <GuardianRowActions token={token} guardian={guardian as GuardianView} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <AddGuardian token={token} />

      <div className="flex justify-end">
        <LinkButton href={`/apply/${token}/course`}>Continue to course</LinkButton>
      </div>
    </div>
  );
}
