"use client";

import { SubNav } from "@/components/sub-nav";

/**
 * The four steps that are the applicant's.
 *
 * Steps are numbered but not locked: an applicant who has to go and scan a
 * certificate should be able to fill in the rest meanwhile, and every step
 * saves on its own. Completeness is checked once, when they press Finish.
 */
export function ApplyNav({ token }: { token: string }) {
  const base = `/apply/${token}`;
  return (
    <SubNav
      tabs={[
        { label: "1. Your details", href: `${base}/student` },
        { label: "2. Parent / guardian", href: `${base}/guardians` },
        { label: "3. Course", href: `${base}/course` },
        { label: "4. Documents", href: `${base}/documents` },
        { label: "5. Finish", href: `${base}/finish` },
      ]}
    />
  );
}
