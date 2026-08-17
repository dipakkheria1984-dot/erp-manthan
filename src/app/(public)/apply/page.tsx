import type { Metadata } from "next";
import { connection } from "next/server";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { paymentIsOffered } from "@/lib/applicant-payment";
import { Alert, Card } from "@/components/ui";
import { StartForm } from "./start-form";

export const metadata: Metadata = { title: "Apply online" };

/**
 * The public landing page. Shows what the applicant is about to fill in, what
 * they will need to hand, and where it stops — the fee conversation is the
 * office's, and saying so here prevents the obvious support call.
 */
export default async function ApplyPage() {
  // Nothing on this page reads a cookie or a header, so Next would otherwise
  // prerender it at build time — and the answer to "are admissions open?" would
  // be whatever the database said when the deploy was built, permanently.
  // Ticking the box in Setup would change the row and never change the page.
  await connection();

  const config = await getConfig().catch((error) => {
    // Failing closed is right for a public page, but silently: a broken config
    // used to be indistinguishable from admissions being shut, which is exactly
    // how a missing column hid itself once already.
    console.error("[apply] could not read the institute configuration", error);
    return null;
  });

  if (!config?.onlineAdmissionsEnabled) {
    return (
      <Alert tone="info" title="Online admissions are closed">
        We are not accepting online applications at the moment. Please contact the admissions office.
      </Alert>
    );
  }

  const requirements = await prisma.documentRequirement.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: { label: true, isRequired: true },
  });

  // Whether the applicant will actually meet a payment step. Said here so the
  // page describes the form they are about to fill in rather than a form the
  // institute has not switched on.
  const paymentOffered = paymentIsOffered(config);

  return (
    <div className="space-y-6">
      <Card title="Before you begin">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Your personal and contact details</li>
          <li>Your parent or guardian&rsquo;s details</li>
          <li>The department and course you want to apply for</li>
          <li>Scanned copies of your documents, if you have them (PDF, JPG or PNG)</li>
          {paymentOffered ? <li>The registration fee, if you want to pay it now</li> : null}
        </ol>
        {requirements.length > 0 ? (
          <div className="mt-4">
            <p className="text-sm font-medium">Documents to have ready</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">
              {requirements.map((requirement) => (
                <li key={requirement.label}>
                  {requirement.label}
                  {requirement.isRequired ? "" : " (optional)"}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mt-4 text-sm text-muted">
          If you cannot upload a document you can still send your form in — bring a physical copy to the
          admissions office once your admission is confirmed.
        </p>
        <p className="mt-2 text-sm text-muted">
          {paymentOffered ? (
            <>
              The last step offers you the registration fee to pay online. Paying is optional — you can send your
              form in without it and settle at the admissions office instead. Whichever you choose, the office
              confirms your admission and sets out the rest of the course fees once they have placed you in a
              batch.
            </>
          ) : (
            <>
              You do not pay anything here. Once your form is in, the admissions office will check it and contact
              you about the fees and how to pay them.
            </>
          )}
        </p>
      </Card>

      <StartForm />
    </div>
  );
}
