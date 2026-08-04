import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getInstitute } from "@/lib/config";
import { visibleSections } from "@/lib/nav";
import { AppShell } from "@/components/app-shell";
import { logoutAction } from "@/app/(auth)/actions";
import { Button } from "@/components/ui";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  // A temporary password must be replaced before anything else is reachable.
  if (user.mustResetPassword) redirect("/reset-password");

  const institute = await getInstitute().catch(() => null);

  return (
    <AppShell
      sections={visibleSections(user.permissions)}
      instituteName={institute?.name ?? "Institute ERP"}
      user={{ name: user.name, roleName: user.roleName }}
      signOut={
        <form action={logoutAction}>
          <Button type="submit" variant="secondary" size="sm">
            Sign out
          </Button>
        </form>
      }
    >
      {children}
    </AppShell>
  );
}
