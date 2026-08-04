"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { recordAudit } from "@/lib/audit";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import {
  createSession,
  destroyAllSessionsFor,
  destroySession,
  hashPassword,
  requireUser,
  validatePasswordStrength,
  verifyPassword,
} from "@/lib/auth";

const loginSchema = z.object({
  email: z.string().trim().min(1, "Email is required.").email("Enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

/**
 * Sign in. Failed attempts are counted and the account locks for a configurable
 * window once the limit is reached (spec 8.2). The response deliberately does
 * not distinguish "no such user" from "wrong password".
 */
export async function loginAction(_prev: unknown, formData: FormData): Promise<ActionResult<{ mustReset: boolean }>> {
  return runAction(async () => {
    const parsed = loginSchema.safeParse({
      email: formData.get("email"),
      password: formData.get("password"),
    });
    if (!parsed.success) {
      return fail("Please correct the highlighted fields.", z.flattenError(parsed.error).fieldErrors);
    }

    const config = await getConfig();
    const genericFailure = fail("Incorrect email or password.");

    const user = await prisma.user.findUnique({
      where: { email: parsed.data.email.toLowerCase() },
      include: { role: true },
    });
    if (!user) return genericFailure;

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      return fail(`This account is locked. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }

    if (user.status !== "ACTIVE") {
      return fail("This account has been deactivated. Contact your administrator.");
    }

    const valid = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!valid) {
      const attempts = user.failedLoginAttempts + 1;
      const shouldLock = attempts >= config.maxFailedLoginAttempts;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: shouldLock ? 0 : attempts,
          lockedUntil: shouldLock ? new Date(Date.now() + config.lockoutMinutes * 60_000) : null,
        },
      });
      await recordAudit({
        userId: user.id,
        action: "auth.login_failed",
        entityType: "User",
        entityId: user.id,
        summary: shouldLock
          ? `Failed sign-in for ${user.email}; account locked for ${config.lockoutMinutes} minutes`
          : `Failed sign-in for ${user.email} (attempt ${attempts})`,
      });
      if (shouldLock) {
        return fail(`Too many failed attempts. This account is locked for ${config.lockoutMinutes} minutes.`);
      }
      return genericFailure;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await createSession(user.id);
    await recordAudit({
      userId: user.id,
      action: "auth.login",
      entityType: "User",
      entityId: user.id,
      summary: `${user.name} signed in as ${user.role.name}`,
    });

    return ok({ mustReset: user.mustResetPassword });
  });
}

export async function logoutAction(): Promise<void> {
  try {
    const current = await requireUser();
    await recordAudit({
      userId: current.id,
      action: "auth.logout",
      entityType: "User",
      entityId: current.id,
      summary: `${current.name} signed out`,
    });
  } catch {
    // Already signed out — nothing to log.
  }
  await destroySession();
  redirect("/login");
}

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: z.string().min(1, "Enter a new password."),
    confirmPassword: z.string().min(1, "Confirm your new password."),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

/** Used both by the forced first-login reset and by voluntary password changes. */
export async function changePasswordAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const session = await requireUser();
    const parsed = changePasswordSchema.safeParse({
      currentPassword: formData.get("currentPassword"),
      newPassword: formData.get("newPassword"),
      confirmPassword: formData.get("confirmPassword"),
    });
    if (!parsed.success) {
      return fail("Please correct the highlighted fields.", z.flattenError(parsed.error).fieldErrors);
    }

    const config = await getConfig();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.id } });

    if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
      return fail("Your current password is incorrect.", { currentPassword: ["Incorrect password."] });
    }
    if (await verifyPassword(parsed.data.newPassword, user.passwordHash)) {
      return fail("Choose a password you have not used before.", {
        newPassword: ["New password must differ from the current one."],
      });
    }

    const problems = validatePasswordStrength(parsed.data.newPassword, config.passwordMinLength);
    if (problems.length) {
      return fail("Password does not meet the policy.", { newPassword: problems });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(parsed.data.newPassword), mustResetPassword: false },
    });
    // Force every other device to sign in again with the new password.
    await destroyAllSessionsFor(user.id);
    await createSession(user.id);

    await recordAudit({
      userId: user.id,
      action: "auth.password_changed",
      entityType: "User",
      entityId: user.id,
      summary: `${user.name} changed their password`,
    });

    return ok(undefined, "Password updated.");
  });
}
