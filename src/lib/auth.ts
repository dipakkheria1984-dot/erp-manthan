import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { AuthError, ForbiddenError } from "@/lib/errors";
import { hasPermission, type Permission } from "@/lib/permissions";

export const SESSION_COOKIE = "erp_session";

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  employeeId: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  departmentId: string | null;
  mustResetPassword: boolean;
};

// --- password ---------------------------------------------------------------

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Policy check used at account creation and password reset (spec 8.2). */
export function validatePasswordStrength(password: string, minLength: number): string[] {
  const problems: string[] = [];
  if (password.length < minLength) problems.push(`Must be at least ${minLength} characters.`);
  if (!/[a-z]/.test(password)) problems.push("Must contain a lowercase letter.");
  if (!/[A-Z]/.test(password)) problems.push("Must contain an uppercase letter.");
  if (!/[0-9]/.test(password)) problems.push("Must contain a digit.");
  if (!/[^A-Za-z0-9]/.test(password)) problems.push("Must contain a special character.");
  return problems;
}

// --- session ----------------------------------------------------------------

function hashToken(token: string): string {
  return createHash("sha256").update(`${token}${env.authSecret}`).digest("hex");
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + env.sessionTtlHours * 60 * 60 * 1000);
  const h = await headers();

  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: h.get("user-agent") ?? null,
    },
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  store.delete(SESSION_COOKIE);
}

/** Invalidate every session for a user — used on deactivation and role change. */
export async function destroyAllSessionsFor(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

/**
 * The signed-in user, or null.
 *
 * Memoised for the life of one request. The app layout resolves the session to
 * build the navigation, and then every page guard resolves it again — three or
 * four identical lookups before a page has fetched any of its own data. Against
 * a database in another region that is most of a second spent re-answering the
 * same question. `cache` is request-scoped, so a sign-in or sign-out in one
 * request is never seen by another.
 */
export const getSessionUser = cache(async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { role: true } } },
  });

  if (!session || session.expiresAt < new Date()) return null;
  if (session.user.status !== "ACTIVE") return null;

  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    employeeId: session.user.employeeId,
    roleId: session.user.roleId,
    roleName: session.user.role.name,
    permissions: session.user.role.permissions,
    departmentId: session.user.departmentId,
    mustResetPassword: session.user.mustResetPassword,
  };
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError();
  return user;
}

/**
 * Assert a permission and throw on failure. Use this in **server actions**,
 * where `runAction` turns the error into a friendly result the form can show.
 */
export async function assertPermission(...permissions: Permission[]): Promise<SessionUser> {
  const user = await requireUser();
  const allowed = permissions.some((p) => hasPermission(user.permissions, p));
  if (!allowed) throw new ForbiddenError();
  return user;
}

/**
 * Guard a **page or layout**. A thrown error here would surface as a 500, so a
 * denial redirects to the access-denied screen instead. Signed-out users are
 * sent to the login page by the app layout before this runs.
 */
export async function requirePermission(...permissions: Permission[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!permissions.some((p) => hasPermission(user.permissions, p))) {
    redirect("/denied");
  }
  return user;
}

export async function can(permission: Permission): Promise<boolean> {
  const user = await getSessionUser();
  return !!user && hasPermission(user.permissions, permission);
}

/** Best-effort request metadata for audit rows. */
export async function requestContext(): Promise<{ ipAddress: string | null; userAgent: string | null }> {
  const h = await headers();
  return {
    ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent") ?? null,
  };
}
