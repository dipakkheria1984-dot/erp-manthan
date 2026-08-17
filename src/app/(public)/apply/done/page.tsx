import type { Metadata } from "next";
import { connection } from "next/server";
import { getInstitute } from "@/lib/config";
import { Alert, Card } from "@/components/ui";

export const metadata: Metadata = { title: "Application sent" };

/**
 * Deliberately outside `[token]`: the token is destroyed as the form is sent,
 * so a confirmation under it would fail the moment it was rendered.
 */
export default async function ApplyDonePage() {
  await connection();
  const institute = await getInstitute().catch(() => null);

  return (
    <div className="space-y-6">
      <Alert tone="success" title="Thank you — your form is with us">
        Your admission form has been sent to the admissions office.
      </Alert>
      <Card title="What happens next">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>The office checks your details and the documents you uploaded.</li>
          <li>They place you in a batch for the course you chose.</li>
          <li>They contact you about the course fees and how to pay them.</li>
        </ol>
        {/* Generic on purpose: the link is destroyed as the form is sent, so
            this page cannot know which documents were outstanding. */}
        <div className="mt-4">
          <Alert tone="warning" title="If you did not upload every document">
            Please bring a physical copy of anything still outstanding to the admissions office once your
            admission is confirmed. Your application is not held up by it.
          </Alert>
        </div>
        <p className="mt-4 text-sm text-muted">
          Your form link no longer works, so keep any reference the office gives you.
          {institute?.contactPhone || institute?.contactEmail ? (
            <>
              {" "}
              If you need to change something, contact the admissions office
              {institute?.contactPhone ? ` on ${institute.contactPhone}` : ""}
              {institute?.contactEmail ? ` or at ${institute.contactEmail}` : ""}.
            </>
          ) : null}
        </p>
      </Card>
    </div>
  );
}
