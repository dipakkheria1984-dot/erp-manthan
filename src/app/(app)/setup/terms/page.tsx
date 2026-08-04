import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { TERMS_DOCUMENTS, termsInForce } from "@/lib/terms";
import { formatDate, formatDateTime } from "@/lib/dates";
import { Alert, Badge, Card, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { TermsEditor, TermsPreview } from "./terms-editor";

export const metadata = { title: "Terms & conditions · Setup" };

export default async function TermsPage() {
  await requirePermission(PERMISSIONS.TERMS_MANAGE);

  // Each printed document keeps its own terms on its own version sequence, so
  // the page is the same block repeated once per document.
  const sections = await Promise.all(
    TERMS_DOCUMENTS.map(async (document) => ({
      ...document,
      versions: await prisma.termsVersion.findMany({
        where: { document: document.key },
        include: { createdBy: { select: { name: true } } },
        orderBy: { version: "desc" },
      }),
      current: await termsInForce(document.key),
    })),
  );

  return (
    <>
      <PageHeader
        title="Terms & conditions"
        description="Print-only. There is no digital acceptance checkbox anywhere in this system — the admission form and the fee receipt each carry their own terms, managed separately below."
      />

      <div className="space-y-6">
        <Alert tone="info" title="Versioning">
          Every save creates a new version; earlier versions are never deleted. A receipt prints whichever version was
          in force on its payment date, so reprinting an old receipt still shows the terms that applied at the time.
          Version numbers run separately per document — admission v3 and receipt v3 are unrelated.
        </Alert>

        {sections.map((section) => (
          <Card key={section.key} title={`${section.label} terms`} description={section.printedOn}>
            <div className="space-y-5">
              <TableWrap>
                <thead>
                  <tr>
                    <Th className="w-20">Version</Th>
                    <Th>Title</Th>
                    <Th>Effective from</Th>
                    <Th>Created</Th>
                    <Th>Created by</Th>
                    <Th className="w-28">In force</Th>
                  </tr>
                </thead>
                <tbody>
                  {section.versions.length === 0 ? (
                    <tr>
                      <Td colSpan={6} className="text-center text-muted">
                        No versions yet — nothing will be printed on this document until one is saved.
                      </Td>
                    </tr>
                  ) : (
                    section.versions.map((version) => (
                      <Tr key={version.id}>
                        <Td className="tabular-nums font-medium">v{version.version}</Td>
                        <Td>{version.title}</Td>
                        <Td className="whitespace-nowrap">{formatDate(version.effectiveFrom)}</Td>
                        <Td className="whitespace-nowrap text-muted">{formatDateTime(version.createdAt)}</Td>
                        <Td className="text-muted">{version.createdBy?.name ?? "System"}</Td>
                        <Td>
                          {section.current?.id === version.id ? (
                            <Badge tone="success">Current</Badge>
                          ) : (
                            <Badge>Archived</Badge>
                          )}
                        </Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </TableWrap>

              {section.current ? (
                <div className="rounded-md border border-border bg-background p-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                    Currently in force — v{section.current.version} · {section.current.title}
                  </p>
                  <TermsPreview html={section.current.content} />
                </div>
              ) : null}

              <div className="border-t border-border pt-5">
                <h3 className="mb-3 text-sm font-semibold">New {section.label.toLowerCase()} version</h3>
                <TermsEditor
                  document={section.key}
                  documentLabel={section.label}
                  defaultTitle={section.current?.title ?? "Terms and Conditions"}
                  defaultContent={section.current?.content ?? ""}
                />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
