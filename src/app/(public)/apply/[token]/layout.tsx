import type { ReactNode } from "react";
import type { Metadata } from "next";
import { applicationForToken, type PortalRejection } from "@/lib/applicant-portal";
import { Alert } from "@/components/ui";
import { ApplyNav } from "./apply-nav";

// Without this the applicant's tab reads "Institute ERP", which names the staff
// system at somebody who is not a member of staff.
export const metadata: Metadata = { title: "Admission form" };

const REJECTION: Record<PortalRejection, { title: string; body: string }> = {
  // Finishing destroys the token, so an applicant returning to their own link
  // afterwards lands here rather than on "finished" — the lookup has nothing
  // left to match. The wording has to cover both, because a spent link is the
  // commonest reason someone arrives at this screen.
  unknown: {
    title: "This link no longer works",
    body: "It may already have been used to send your form in, in which case it is with the admissions office and they will contact you. Otherwise check you copied the whole link, and if it still does not work, contact the office.",
  },
  expired: {
    title: "This link has expired",
    body: "Contact the admissions office and they will send you a fresh one.",
  },
  finished: {
    title: "Your form is already with us",
    body: "This application has been sent to the admissions office and can no longer be edited. They will contact you about the fees.",
  },
  closed: {
    title: "Online admissions are closed",
    body: "We are not accepting online applications at the moment. Please contact the admissions office.",
  },
};

/**
 * Resolves the token once for every step beneath it.
 *
 * A bad token gets an explanation rather than a 404: the applicant is a member
 * of the public who may simply have a stale link, and "not found" tells them
 * nothing about what to do next.
 */
export default async function TokenLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await applicationForToken(token);

  if (!result.ok) {
    const { title, body } = REJECTION[result.reason];
    return (
      <Alert tone={result.reason === "finished" ? "success" : "warning"} title={title}>
        {body}
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{result.application.fullName}</h1>
        <p className="text-sm text-muted">
          Your answers save as you go. You can close this page and come back with the same link.
        </p>
      </div>
      <ApplyNav token={token} />
      {children}
    </div>
  );
}
