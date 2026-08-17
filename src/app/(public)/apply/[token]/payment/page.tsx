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

  // Neither a link nor a UPI ID means the institute is not taking money online
  // at all, so the step says so rather than showing a dead button.
  // Paying by UPI deep link did not work in practice and is parked — see the
  // note on `registrationUpiId`. Applicants are offered the hosted page, and
  // the QR once the institute switches it on.
  const showQr = Boolean(config.paymentQrStoragePath) && config.paymentQrEnabled;
  if (!config.registrationPaymentUrl && !showQr) {
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

  // Built here rather than in the client component: the QR is rendered server
  // side so no library ships to the applicant's browser, and an inline SVG
  // means the code is not fetched from anywhere.
  // Only ever the institute's own uploaded image. Nothing is generated: a code
  // drawn from a VPA is a guess at what the bank issued, and one that will not
  // scan is worse than none.
  const qrImageUrl = showQr ? `/api/payment-qr?v=${config.paymentQrUpdatedAt?.getTime() ?? 0}` : null;

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
        qrImageUrl={qrImageUrl}
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
