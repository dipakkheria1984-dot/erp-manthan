"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { recordAudit } from "@/lib/audit";
import { destroyAllSessionsFor, hashPassword, assertPermission, validatePasswordStrength } from "@/lib/auth";
import { ALL_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { fieldErrorsOf, formObject, optionalText, requiredText } from "@/lib/validation";

/** Temporary password handed to a new user; they must change it on first login. */
function generateTemporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(12);
  const core = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  // Guarantee the generated value satisfies the strongest policy we allow.
  return `Aa1@${core}`;
}

const userSchema = z.object({
  id: optionalText,
  name: requiredText("Name", 2),
  employeeId: requiredText("Employee ID", 1),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  phone: optionalText,
  roleId: requiredText("Role"),
  departmentId: optionalText,
  status: z.enum(["ACTIVE", "INACTIVE"]),
});

export async function saveUserAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<{ temporaryPassword?: string }>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.USERS_MANAGE);
    const parsed = userSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { id, ...data } = parsed.data;

    const clash = await prisma.user.findFirst({
      where: {
        OR: [{ email: data.email }, { employeeId: data.employeeId }],
        ...(id ? { NOT: { id } } : {}),
      },
    });
    if (clash) {
      return fail("Those details are already in use.", {
        ...(clash.email === data.email ? { email: ["Already registered."] } : {}),
        ...(clash.employeeId === data.employeeId ? { employeeId: ["Already in use."] } : {}),
      });
    }

    const role = await prisma.role.findUnique({ where: { id: data.roleId } });
    if (!role) return fail("Select a valid role.", { roleId: ["Unknown role."] });

    if (id) {
      const before = await prisma.user.findUnique({ where: { id } });
      if (!before) return fail("User not found.");

      // Don't let an Admin lock themselves — or the institute — out.
      if (before.id === actor.id && data.status === "INACTIVE") {
        return fail("You cannot deactivate your own account.");
      }
      if (before.roleId !== data.roleId || before.status !== data.status) {
        const adminRole = await prisma.role.findFirst({ where: { name: "Admin" } });
        if (adminRole && before.roleId === adminRole.id) {
          const activeAdmins = await prisma.user.count({ where: { roleId: adminRole.id, status: "ACTIVE" } });
          const stillAdmin = data.roleId === adminRole.id && data.status === "ACTIVE";
          if (activeAdmins <= 1 && !stillAdmin) {
            return fail("This is the only active Admin account — assign another Admin first.");
          }
        }
      }

      await prisma.user.update({ where: { id }, data });
      // A changed role or a deactivation must take effect immediately.
      if (before.roleId !== data.roleId || data.status === "INACTIVE") {
        await destroyAllSessionsFor(id);
      }

      await recordAudit({
        userId: actor.id,
        action: "user.updated",
        entityType: "User",
        entityId: id,
        summary: `Staff account ${data.email} updated (role: ${role.name}, status: ${data.status})`,
        metadata: { before: { roleId: before.roleId, status: before.status }, after: { roleId: data.roleId, status: data.status } },
      });
      revalidatePath("/users");
      return ok({}, "Staff account updated.");
    }

    const temporaryPassword = generateTemporaryPassword();
    const created = await prisma.user.create({
      data: {
        ...data,
        passwordHash: await hashPassword(temporaryPassword),
        mustResetPassword: true,
      },
    });

    await recordAudit({
      userId: actor.id,
      action: "user.created",
      entityType: "User",
      entityId: created.id,
      summary: `Staff account ${data.email} created with role ${role.name}`,
    });
    revalidatePath("/users");
    return ok(
      { temporaryPassword },
      `Account created. Share this temporary password securely — it is shown once: ${temporaryPassword}`,
    );
  });
}

export async function resetUserPasswordAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<{ temporaryPassword: string }>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.USERS_MANAGE);
    const id = String(formData.get("id") ?? "");
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return fail("User not found.");

    const temporaryPassword = generateTemporaryPassword();
    const config = await getConfig();
    // Sanity check: the generator must satisfy the configured policy.
    const problems = validatePasswordStrength(temporaryPassword, config.passwordMinLength);
    if (problems.length) return fail("Could not generate a compliant temporary password.");

    await prisma.user.update({
      where: { id },
      data: {
        passwordHash: await hashPassword(temporaryPassword),
        mustResetPassword: true,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    await destroyAllSessionsFor(id);

    await recordAudit({
      userId: actor.id,
      action: "user.password_reset",
      entityType: "User",
      entityId: id,
      summary: `Password reset for ${user.email}`,
    });
    revalidatePath("/users");
    return ok(
      { temporaryPassword },
      `Temporary password for ${user.email} — shown once: ${temporaryPassword}`,
    );
  });
}

export async function unlockUserAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.USERS_MANAGE);
    const id = String(formData.get("id") ?? "");
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return fail("User not found.");

    await prisma.user.update({ where: { id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    await recordAudit({
      userId: actor.id,
      action: "user.unlocked",
      entityType: "User",
      entityId: id,
      summary: `Account unlocked for ${user.email}`,
    });
    revalidatePath("/users");
    return ok(undefined, "Account unlocked.");
  });
}

/* -------------------------------------------------------------------------- */
/* Roles                                                                       */
/* -------------------------------------------------------------------------- */

const roleSchema = z.object({
  id: optionalText,
  name: requiredText("Role name", 2),
  description: optionalText,
  permissions: z.union([z.string(), z.array(z.string())]).optional(),
});

export async function saveRoleAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ROLES_MANAGE);
    const parsed = roleSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { id, name, description } = parsed.data;
    const raw = parsed.data.permissions;
    const selected = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((p) =>
      (ALL_PERMISSIONS as string[]).includes(p),
    );
    if (selected.length === 0) return fail("Select at least one permission.", { permissions: ["Select at least one."] });

    const clash = await prisma.role.findFirst({ where: { name, ...(id ? { NOT: { id } } : {}) } });
    if (clash) return fail("A role with that name already exists.", { name: ["Already in use."] });

    if (id) {
      const before = await prisma.role.findUnique({ where: { id } });
      if (!before) return fail("Role not found.");
      // Predefined roles keep their identity; only Admin's permission set is fixed.
      if (before.isSystem && before.name === "Admin") {
        return fail("The Admin role always holds every permission and cannot be edited.");
      }

      await prisma.role.update({
        where: { id },
        data: { name: before.isSystem ? before.name : name, description, permissions: selected },
      });
      // Permission changes must not wait for the next sign-in.
      const affected = await prisma.user.findMany({ where: { roleId: id }, select: { id: true } });
      await Promise.all(affected.map((u) => destroyAllSessionsFor(u.id)));

      await recordAudit({
        userId: actor.id,
        action: "role.updated",
        entityType: "Role",
        entityId: id,
        summary: `Role ${before.name} updated (${selected.length} permissions)`,
        metadata: { before: before.permissions, after: selected },
      });
    } else {
      const created = await prisma.role.create({
        data: { name, description, permissions: selected, isSystem: false },
      });
      await recordAudit({
        userId: actor.id,
        action: "role.created",
        entityType: "Role",
        entityId: created.id,
        summary: `Custom role ${name} created (${selected.length} permissions)`,
      });
    }

    revalidatePath("/users/roles");
    revalidatePath("/users");
    return ok(undefined, "Role saved.");
  });
}

export async function deleteRoleAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const actor = await assertPermission(PERMISSIONS.ROLES_MANAGE);
    const id = String(formData.get("id") ?? "");
    const role = await prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) return fail("Role not found.");
    if (role.isSystem) return fail("Predefined roles cannot be deleted.");
    if (role._count.users > 0) {
      return fail(`${role._count.users} staff account(s) still use this role. Reassign them first.`);
    }

    await prisma.role.delete({ where: { id } });
    await recordAudit({
      userId: actor.id,
      action: "role.deleted",
      entityType: "Role",
      entityId: id,
      summary: `Custom role ${role.name} deleted`,
    });
    revalidatePath("/users/roles");
    return ok(undefined, "Role deleted.");
  });
}
