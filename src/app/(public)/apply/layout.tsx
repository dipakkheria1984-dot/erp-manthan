import type { ReactNode } from "react";
import { connection } from "next/server";
import { getInstitute } from "@/lib/config";

/**
 * Shell for the public admission form.
 *
 * Deliberately outside the `(app)` group: that layout resolves a session and
 * redirects to /login when there is none, which is exactly what must not happen
 * here. Nothing under `/apply` reads the signed-in user, and none of it renders
 * the staff navigation — an applicant sees the institute's name and their own
 * form, nothing else about the system.
 */
export default async function ApplyLayout({ children }: { children: ReactNode }) {
  // Read at request time, not baked in at build: the institute's name and the
  // contact details in the footer are edited in Setup and must not be a
  // snapshot of whatever they were when the deployment was built.
  await connection();
  const institute = await getInstitute().catch(() => null);

  return (
    <div className="min-h-full bg-background">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          <span className="text-lg font-semibold">{institute?.name ?? "Admissions"}</span>
          <span className="text-sm text-muted">Admission form</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>
      <footer className="mx-auto max-w-3xl px-4 pb-10 text-xs text-muted">
        {institute?.contactPhone || institute?.contactEmail ? (
          <p>
            Need help? Contact the admissions office
            {institute?.contactPhone ? ` on ${institute.contactPhone}` : ""}
            {institute?.contactEmail ? ` or at ${institute.contactEmail}` : ""}.
          </p>
        ) : null}
      </footer>
    </div>
  );
}
