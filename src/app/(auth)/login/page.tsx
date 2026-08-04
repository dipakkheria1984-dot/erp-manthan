import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getInstitute } from "@/lib/config";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · Institute ERP" };

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/dashboard");

  // The institute name is public branding on the sign-in screen; fall back to a
  // neutral title when the database has not been seeded yet.
  const institute = await getInstitute().catch(() => null);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-lift">
      {/* The institute's name reversed out of the brand, exactly as it appears
          at the head of the sidebar once you are inside. */}
      <div className="brand-gradient px-8 py-7 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-brand-fg text-balance">
          {institute?.name ?? "Institute ERP"}
        </h1>
        <p className="mt-1 text-sm text-brand-fg/75">Sign in to continue</p>
      </div>
      <div className="p-8">
        <LoginForm />
      </div>
    </div>
  );
}
