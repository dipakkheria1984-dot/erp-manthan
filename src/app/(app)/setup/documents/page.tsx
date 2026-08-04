import { prisma } from "@/lib/db";
import { Badge, Card, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { DocumentEditor, DocumentRowActions } from "./document-editor";

export const metadata = { title: "Document checklist · Setup" };

export default async function DocumentsPage() {
  const items = await prisma.documentRequirement.findMany({ orderBy: [{ sortOrder: "asc" }, { label: "asc" }] });

  return (
    <>
      <PageHeader
        title="Document checklist"
        description="Drives the upload step of the enrollment wizard. Items marked expected are flagged as outstanding until they are uploaded, but no document blocks submission or approval."
      />
      <div className="space-y-6">
        <Card title="Checklist items">
          <TableWrap>
            <thead>
              <tr>
                <Th className="w-16">Order</Th>
                <Th>Code</Th>
                <Th>Label</Th>
                <Th>Collection</Th>
                <Th>Status</Th>
                <Th className="w-40" />
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <Td colSpan={6} className="text-center text-muted">
                    No checklist items yet.
                  </Td>
                </tr>
              ) : (
                items.map((item) => (
                  <Tr key={item.id}>
                    <Td className="tabular-nums">{item.sortOrder}</Td>
                    <Td className="font-mono text-xs">{item.code}</Td>
                    <Td>{item.label}</Td>
                    <Td>{item.isRequired ? <Badge tone="warning">Expected</Badge> : <Badge>Optional</Badge>}</Td>
                    <Td>{item.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>}</Td>
                    <Td>
                      <DocumentRowActions
                        item={{
                          id: item.id,
                          code: item.code,
                          label: item.label,
                          isRequired: item.isRequired,
                          isActive: item.isActive,
                          sortOrder: item.sortOrder,
                        }}
                      />
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </TableWrap>
        </Card>

        <Card title="Add a checklist item">
          <DocumentEditor />
        </Card>
      </div>
    </>
  );
}
