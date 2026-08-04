import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { ChangePasswordForm } from "./change-password-form";

export const metadata = { title: "Set a new password · Institute ERP" };

export default async function ResetPasswordPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const config = await getConfig();

  return (
    <div className="rounded-lg border border-border bg-surface p-8 shadow-sm">
      <h1 className="text-xl font-semibold">
        {user.mustResetPassword ? "Set a new password" : "Change your password"}
      </h1>
      <p className="mt-1 mb-6 text-sm text-muted">
        {user.mustResetPassword
          ? "Your account was created with a temporary password. Choose a new one to continue."
          : "Signed in as " + user.email}
      </p>
      <ChangePasswordForm minLength={config.passwordMinLength} forced={user.mustResetPassword} />
    </div>
  );
}
