import { requireUser } from "@/lib/auth";
import { Card, LinkButton, PageHeader } from "@/components/ui";

export const metadata = { title: "Access denied" };

export default async function DeniedPage() {
  const user = await requireUser();

  return (
    <>
      <PageHeader title="Access denied" />
      <Card>
        <p className="text-sm">
          Your role (<strong>{user.roleName}</strong>) does not grant access to that page.
        </p>
        <p className="mt-2 text-sm text-muted">
          If you need it, ask an Admin to review your role&apos;s permissions in Staff accounts → Roles.
        </p>
        <div className="mt-5">
          <LinkButton href="/dashboard">Back to dashboard</LinkButton>
        </div>
      </Card>
    </>
  );
}
