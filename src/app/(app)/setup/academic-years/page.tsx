import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/dates";
import { Badge, Card, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { AcademicYearEditor, AcademicYearRowActions } from "./academic-year-editor";

export const metadata = { title: "Academic years · Setup" };

export default async function AcademicYearsPage() {
  const years = await prisma.academicYear.findMany({ orderBy: { startDate: "desc" } });

  return (
    <>
      <PageHeader
        title="Academic years"
        description="Sessions students are enrolled into. Exam and activity fees are versioned by academic year — past years are never overwritten."
      />
      <div className="space-y-6">
        <Card title="Defined years">
          <TableWrap>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Starts</Th>
                <Th>Ends</Th>
                <Th>Status</Th>
                <Th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {years.length === 0 ? (
                <tr>
                  <Td colSpan={5} className="text-center text-muted">
                    No academic years defined yet.
                  </Td>
                </tr>
              ) : (
                years.map((year) => (
                  <Tr key={year.id}>
                    <Td className="font-medium">{year.name}</Td>
                    <Td>{formatDate(year.startDate)}</Td>
                    <Td>{formatDate(year.endDate)}</Td>
                    <Td>{year.isCurrent ? <Badge tone="success">Current</Badge> : <Badge>Past / future</Badge>}</Td>
                    <Td>
                      <AcademicYearRowActions
                        year={{
                          id: year.id,
                          name: year.name,
                          startDate: year.startDate.toISOString(),
                          endDate: year.endDate.toISOString(),
                          isCurrent: year.isCurrent,
                        }}
                      />
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </TableWrap>
        </Card>

        <Card title="Add an academic year">
          <AcademicYearEditor />
        </Card>
      </div>
    </>
  );
}
