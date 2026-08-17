"use client";

import { SubNav } from "@/components/sub-nav";

/**
 * The four steps that are the applicant's.
 *
 * Steps are numbered but not locked: an applicant who has to go and scan a
 * certificate should be able to fill in the rest meanwhile, and every step
 * saves on its own. Completeness is checked once, when they press Finish.
 */
export function ApplyNav({ token, paymentOffered }: { token: string; paymentOffered: boolean }) {
  const base = `/apply/${token}`;
  // The fee step only appears when there is somewhere to pay. Listing it
  // otherwise sends the applicant to a screen that tells them there is nothing
  // to do there.
  const steps = [
    { label: "Your details", href: `${base}/student` },
    { label: "Parent / guardian", href: `${base}/guardians` },
    { label: "Course", href: `${base}/course` },
    { label: "Documents", href: `${base}/documents` },
    ...(paymentOffered ? [{ label: "Registration fee", href: `${base}/payment` }] : []),
    { label: "Finish", href: `${base}/finish` },
  ];
  return <SubNav tabs={steps.map((step, i) => ({ ...step, label: `${i + 1}. ${step.label}` }))} />;
}
