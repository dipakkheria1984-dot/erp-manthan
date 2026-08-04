import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { formatPaise } from "@/lib/money";
import { Alert, Card, PageHeader, TableWrap, Td, Th, Tr } from "@/components/ui";
import { SlabEditor, SlabRowActions } from "./slab-editor";

export const metadata = { title: "Late fee slabs · Setup" };

export default async function LateFeesPage() {
  const [slabs, config] = await Promise.all([
    prisma.lateFeeSlab.findMany({ where: { isActive: true }, orderBy: { minDaysOverdue: "asc" } }),
    getConfig(),
  ]);

  return (
    <>
      <PageHeader
        title="Late fee slabs"
        description="One institute-wide table applies to every course and batch. The slab fee is flat, not prorated."
      />

      <div className="space-y-6">
        <Alert tone="info" title="How the slab is applied">
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>
              Nothing is charged during the {config.lateFeeGraceDays}-day grace period after the due date.
            </li>
            <li>
              No late fee applies at all when the remaining unpaid balance is at or below{" "}
              {formatPaise(config.minOutstandingThresholdPaise)}.
            </li>
            <li>Above that threshold the full slab amount applies, recalculated as the student crosses slabs.</li>
            <li>Accrual stops once the installment principal and late fee are fully paid.</li>
          </ul>
        </Alert>

        <Card title="Current slabs">
          {slabs.length === 0 ? (
            <p className="text-sm text-muted">No slabs configured — no late fee will ever be charged.</p>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>Days overdue</Th>
                  <Th className="text-right">Late fee</Th>
                  <Th className="w-40" />
                </tr>
              </thead>
              <tbody>
                {slabs.map((slab) => (
                  <Tr key={slab.id}>
                    <Td>
                      {slab.minDaysOverdue}–{slab.maxDaysOverdue ?? "onwards"} days
                    </Td>
                    <Td className="text-right tabular-nums">{formatPaise(slab.amountPaise)}</Td>
                    <Td>
                      <SlabRowActions
                        slab={{
                          id: slab.id,
                          minDaysOverdue: slab.minDaysOverdue,
                          maxDaysOverdue: slab.maxDaysOverdue,
                          amountPaise: slab.amountPaise,
                        }}
                      />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <Card title="Add a slab">
          <SlabEditor />
        </Card>
      </div>
    </>
  );
}
