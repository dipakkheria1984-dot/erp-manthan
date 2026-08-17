import type { Metadata } from "next";
import { getInstitute } from "@/lib/config";
import { Alert, Card } from "@/components/ui";

export const metadata: Metadata = { title: "Application sent" };

/**
 * Deliberately outside `[token]`: the token is destroyed as the form is sent,
 * so a confirmation under it would fail the moment it was rendered.
 */
export default async function ApplyDonePage() {
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
