import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { applicationForToken } from "@/lib/applicant-portal";
import { registrationFeeForCourse } from "@/lib/fees";
import { formatPaise, paiseToRupees } from "@/lib/money";
import { toDateInput } from "@/lib/dates";
import { Alert, Card, LinkButton } from "@/components/ui";
import { PaymentPanel } from "./payment-forms";

export default async function PortalPaymentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await applicationForToken(token);
  if (!result.ok) notFound();

  const application = result.application;
  const config = await getConfig();

  // No link configured means the institute is not taking money online at all,
  // so the step says so rather than showing a dead button.
  if (!config.registrationPaymentUrl) {
    return (
      <div className="space-y-6">
        <Alert tone="info" title="Nothing to pay here">
          The registration fee is collected at the admissions office. Carry on and send your form in — they will
          tell you the amount and how to pay when they contact you.
        </Alert>
        <div className="flex justify-end">
          <LinkButton href={`/apply/${token}/finish`}>Continue to finish</LinkButton>
        </div>
      </div>
    );
  }

  const quote = application.courseId
    ? await registrationFeeForCourse(application.courseId, config)
    : { amountPaise: config.minRegistrationFeePaise, batchName: null };

  const claimed =
    application.claimedPaymentReference && application.claimedPaymentPaise !== null
      ? {
          reference: application.claimedPaymentReference,
          amount: paiseToRupees(application.claimedPaymentPaise).toFixed(2),
          paidOn: toDateInput(application.claimedPaymentAt),
        }
      : null;

  return (
    <div className="space-y-6">
      <Card title="What you need to pay">
        <p className="text-2xl font-semibold tabular-nums">{formatPaise(quote.amountPaise)}</p>
        <p className="mt-1 text-sm text-muted">
          {quote.batchName
            ? `Indicative, based on the ${quote.batchName} batch of your chosen course. `
            : "Indicative. "}
          The admissions office places you in a batch and confirms the exact amount — anything over or under is
          settled with them, and paying now does not reserve a seat by itself.
        </p>
      </Card>

      {claimed ? (
        <Alert tone="success" title="Payment details received">
          You told us you paid {formatPaise(application.claimedPaymentPaise ?? 0)} with reference{" "}
          <span className="font-mono">{claimed.reference}</span>. The office will check this against the bank. You
          can correct it below if anything is wrong.
        </Alert>
      ) : (
        <Alert tone="info" title="Paying now is optional">
          You can send your form in without paying and settle the registration fee at the admissions office
          instead. Nothing is held up either way.
        </Alert>
      )}

      <PaymentPanel
        token={token}
        paymentUrl={config.registrationPaymentUrl}
        note={config.registrationPaymentNote}
        amountLabel={formatPaise(quote.amountPaise)}
        existing={claimed}
      />

      <div className="flex justify-end">
        <LinkButton href={`/apply/${token}/finish`}>Continue to finish</LinkButton>
      </div>
    </div>
  );
}
