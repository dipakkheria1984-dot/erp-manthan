"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { assertPermission } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteUpload, storeImage } from "@/lib/storage";
import { getCommunicationConfig, getInstitute } from "@/lib/config";
import { emailIsLive } from "@/lib/notification-providers";
import { deliverEmail } from "@/lib/notifications";
import { fail, ok, runAction, type ActionResult } from "@/lib/errors";
import { PRINT_COLOR_SCHEMES, PRINT_THEMES, normalizeHex } from "@/lib/print-theme";
import {
  checkboxInput,
  dateInput,
  fieldErrorsOf,
  formObject,
  intInput,
  optionalDateInput,
  optionalText,
  requiredText,
  rupeeAmount,
} from "@/lib/validation";

/* -------------------------------------------------------------------------- */
/* 9.1 Institute profile                                                       */
/* -------------------------------------------------------------------------- */

const instituteSchema = z.object({
  name: requiredText("Institute name", 2),
  addressLine1: optionalText,
  addressLine2: optionalText,
  city: optionalText,
  state: optionalText,
  pincode: optionalText,
  contactEmail: optionalText,
  contactPhone: optionalText,
  website: optionalText,
});

export async function saveInstituteProfileAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const parsed = instituteSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    await prisma.institute.upsert({
      where: { id: 1 },
      update: parsed.data,
      create: { id: 1, ...parsed.data },
    });

    await recordAudit({
      userId: user.id,
      action: "institute.profile_updated",
      entityType: "Institute",
      entityId: "1",
      summary: "Institute profile updated",
    });
    revalidatePath("/setup");
    return ok(undefined, "Institute profile saved.");
  });
}

/* -------------------------------------------------------------------------- */
/* 9.1 Institute logo                                                          */
/* -------------------------------------------------------------------------- */

export async function uploadInstituteLogoAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const file = formData.get("logo");
    if (!(file instanceof File) || file.size === 0) {
      return fail("Choose an image to upload.", { logo: ["No file selected."] });
    }

    const institute = await prisma.institute.findUnique({ where: { id: 1 } });
    if (!institute) return fail("Save the institute profile first — the logo is stored alongside it.");

    // `storeImage` rejects anything pdfkit could not embed, so a logo that
    // uploads is a logo that will actually print.
    const stored = await storeImage(file, "institute");

    // Written before the old file is removed: if the delete fails the row is
    // still correct, and the worst outcome is one orphaned image on disk.
    await prisma.institute.update({
      where: { id: 1 },
      data: {
        logoStoragePath: stored.storagePath,
        logoFileName: stored.fileName,
        logoMimeType: stored.mimeType,
        logoSizeBytes: stored.sizeBytes,
        logoUpdatedAt: new Date(),
      },
    });
    if (institute.logoStoragePath) await deleteUpload(institute.logoStoragePath);

    await recordAudit({
      userId: user.id,
      action: "institute.logo_uploaded",
      entityType: "Institute",
      entityId: "1",
      summary: `Institute logo ${institute.logoStoragePath ? "replaced" : "uploaded"} (${stored.fileName})`,
    });
    revalidatePath("/setup");
    revalidatePath("/setup/printing");
    return ok(undefined, "Logo uploaded. It appears on every document generated from now on.");
  });
}

export async function removeInstituteLogoAction(
  _prev: unknown,
  _formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const institute = await prisma.institute.findUnique({ where: { id: 1 } });
    if (!institute?.logoStoragePath) return fail("There is no logo to remove.");

    await prisma.institute.update({
      where: { id: 1 },
      data: {
        logoStoragePath: null,
        logoFileName: null,
        logoMimeType: null,
        logoSizeBytes: null,
        logoUpdatedAt: null,
      },
    });
    await deleteUpload(institute.logoStoragePath);

    await recordAudit({
      userId: user.id,
      action: "institute.logo_removed",
      entityType: "Institute",
      entityId: "1",
      summary: "Institute logo removed",
    });
    revalidatePath("/setup");
    revalidatePath("/setup/printing");
    return ok(undefined, "Logo removed. Documents print with the name alone.");
  });
}

/* -------------------------------------------------------------------------- */
/* 9.1 Printed material appearance                                             */
/* -------------------------------------------------------------------------- */

const SCHEME_IDS = PRINT_COLOR_SCHEMES.map((scheme) => scheme.id);
const THEME_IDS = PRINT_THEMES.map((theme) => theme.id);

const printThemeSchema = z
  .object({
    printColorScheme: z
      .string()
      .trim()
      .refine((v) => SCHEME_IDS.includes(v), "Choose one of the listed colour schemes."),
    printTheme: z
      .string()
      .trim()
      .refine((v) => THEME_IDS.some((id) => id === v), "Choose one of the listed themes."),
    printAccentHex: z
      .string()
      .trim()
      .refine((v) => v === "" || normalizeHex(v) !== null, "Use a hex colour such as #1d4ed8.")
      // Stored normalised so the PDF renderer and the on-screen preview can
      // never disagree over `#ABC` versus `#aabbcc`.
      .transform((v) => (v === "" ? null : normalizeHex(v))),
  })
  .refine((data) => data.printColorScheme !== "custom" || data.printAccentHex !== null, {
    message: "A custom scheme needs an accent colour.",
    path: ["printAccentHex"],
  });

export async function savePrintThemeAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const parsed = printThemeSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    // The appearance hangs off the institute row, so there has to be one. Saying
    // so beats the generic failure `update` would raise on a fresh database.
    const institute = await prisma.institute.findUnique({ where: { id: 1 }, select: { id: true } });
    if (!institute) return fail("Save the institute profile first — the print appearance is stored alongside it.");

    await prisma.institute.update({ where: { id: 1 }, data: parsed.data });

    await recordAudit({
      userId: user.id,
      action: "institute.print_theme_updated",
      entityType: "Institute",
      entityId: "1",
      summary: `Printed material set to ${parsed.data.printColorScheme} / ${parsed.data.printTheme}`,
      metadata: parsed.data,
    });
    // Nothing is cached per-document, but the setup screen reads the saved
    // values back to render its preview.
    revalidatePath("/setup/printing");
    return ok(undefined, "Print appearance saved. New documents use it immediately.");
  });
}

/* -------------------------------------------------------------------------- */
/* 9.2 Global configuration                                                    */
/* -------------------------------------------------------------------------- */

const configSchema = z
  .object({
    studentIdPrefix: requiredText("Student ID prefix").max(10, "Prefix is too long."),
    lfNoLength: intInput("LF No. length", { min: 3, max: 10 }),
    lfNoNext: intInput("Next LF No.", { min: 1 }),
    minRegistrationFeePaise: rupeeAmount("Minimum registration fee", { min: 0 }),
    scholarshipAutoApprovePercent: intInput("Scholarship auto-approval threshold", { min: 0, max: 100 }),
    installmentMin: intInput("Minimum installments", { min: 1, max: 60 }),
    installmentMax: intInput("Maximum installments", { min: 1, max: 60 }),
    lateFeeGraceDays: intInput("Grace period", { min: 0, max: 365 }),
    minOutstandingThresholdPaise: rupeeAmount("Minimum outstanding threshold", { min: 0 }),
    /// Blank means the policy has always applied — the behaviour before this
    /// setting existed.
    lateFeeEffectiveFrom: optionalDateInput,
    preDueReminderDays: intInput("Pre-due reminder days", { min: 0, max: 90 }),
    overdueReminderIntervalDays: intInput("Overdue reminder interval", { min: 1, max: 90 }),
    receiptPrefix: requiredText("Receipt prefix").max(10, "Prefix is too long."),
    receiptPadding: intInput("Receipt number length", { min: 1, max: 12 }),
    applicationPrefix: requiredText("Application ID prefix").max(10, "Prefix is too long."),
    applicationPadding: intInput("Application number length", { min: 1, max: 12 }),
    passwordMinLength: intInput("Minimum password length", { min: 6, max: 64 }),
    maxFailedLoginAttempts: intInput("Failed login limit", { min: 1, max: 20 }),
    lockoutMinutes: intInput("Lockout duration", { min: 1, max: 1440 }),
  })
  .refine((data) => data.installmentMax >= data.installmentMin, {
    message: "Maximum installments must be at least the minimum.",
    path: ["installmentMax"],
  });

export async function saveConfigAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const parsed = configSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const before = await prisma.instituteConfig.findUnique({ where: { id: 1 } });
    // Rolling the LF counter backwards would hand out a number already in use.
    if (before && parsed.data.lfNoNext < before.lfNoNext) {
      const used = await prisma.student.count({ where: { lfNo: { gte: parsed.data.lfNoNext } } });
      if (used > 0) {
        return fail("That LF No. has already been issued.", {
          lfNoNext: [`${used} student(s) already hold an LF No. at or above ${parsed.data.lfNoNext}.`],
        });
      }
    }

    // Written explicitly: `undefined` would leave the old date in place, so
    // clearing the box could never switch the start date back off.
    const data = { ...parsed.data, lateFeeEffectiveFrom: parsed.data.lateFeeEffectiveFrom ?? null };

    await prisma.instituteConfig.upsert({
      where: { id: 1 },
      update: data,
      create: { id: 1, ...data },
    });

    await recordAudit({
      userId: user.id,
      action: "institute.config_updated",
      entityType: "InstituteConfig",
      entityId: "1",
      summary: "Global configuration updated",
      metadata: { before, after: data },
    });
    revalidatePath("/setup/config");
    return ok(undefined, "Configuration saved.");
  });
}

/* -------------------------------------------------------------------------- */
/* 3.2 Late fee slabs                                                          */
/* -------------------------------------------------------------------------- */

const slabSchema = z.object({
  minDaysOverdue: intInput("From day", { min: 1, max: 3650 }),
  maxDaysOverdue: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number.parseInt(v, 10)))
    .refine((v) => v === null || (Number.isFinite(v) && v > 0), "To day must be a positive whole number or blank."),
  amountPaise: rupeeAmount("Late fee amount", { min: 0 }),
});

export async function saveLateFeeSlabAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const id = formData.get("id");
    const parsed = slabSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { minDaysOverdue, maxDaysOverdue, amountPaise } = parsed.data;
    if (maxDaysOverdue !== null && maxDaysOverdue < minDaysOverdue) {
      return fail("Invalid slab range.", { maxDaysOverdue: ["To day must be on or after the from day."] });
    }

    // Slabs must not overlap, or a given overdue count would match two rows.
    const existing = await prisma.lateFeeSlab.findMany({
      where: { isActive: true, ...(typeof id === "string" && id ? { NOT: { id: Number(id) } } : {}) },
    });
    const overlap = existing.find((slab) => {
      const slabMax = slab.maxDaysOverdue ?? Number.MAX_SAFE_INTEGER;
      const newMax = maxDaysOverdue ?? Number.MAX_SAFE_INTEGER;
      return minDaysOverdue <= slabMax && slab.minDaysOverdue <= newMax;
    });
    if (overlap) {
      return fail(
        `This range overlaps the existing slab for days ${overlap.minDaysOverdue}–${overlap.maxDaysOverdue ?? "onwards"}.`,
      );
    }

    if (typeof id === "string" && id) {
      await prisma.lateFeeSlab.update({
        where: { id: Number(id) },
        data: { minDaysOverdue, maxDaysOverdue, amountPaise },
      });
    } else {
      await prisma.lateFeeSlab.create({ data: { minDaysOverdue, maxDaysOverdue, amountPaise } });
    }

    await recordAudit({
      userId: user.id,
      action: "institute.late_fee_slab_saved",
      entityType: "LateFeeSlab",
      entityId: typeof id === "string" ? id : undefined,
      summary: `Late fee slab ${minDaysOverdue}–${maxDaysOverdue ?? "onwards"} days saved`,
      metadata: { minDaysOverdue, maxDaysOverdue, amountPaise },
    });
    revalidatePath("/setup/late-fees");
    return ok(undefined, "Late fee slab saved.");
  });
}

export async function deleteLateFeeSlabAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const id = Number(formData.get("id"));
    if (!Number.isFinite(id)) return fail("Invalid slab.");

    const slab = await prisma.lateFeeSlab.findUnique({ where: { id } });
    if (!slab) return fail("Slab not found.");

    // Deactivate rather than delete — historical late fees were computed from it.
    await prisma.lateFeeSlab.update({ where: { id }, data: { isActive: false } });
    await recordAudit({
      userId: user.id,
      action: "institute.late_fee_slab_removed",
      entityType: "LateFeeSlab",
      entityId: String(id),
      summary: `Late fee slab ${slab.minDaysOverdue}–${slab.maxDaysOverdue ?? "onwards"} days deactivated`,
    });
    revalidatePath("/setup/late-fees");
    return ok(undefined, "Slab removed.");
  });
}

/* -------------------------------------------------------------------------- */
/* 9.3 Communication setup                                                     */
/* -------------------------------------------------------------------------- */

const communicationSchema = z.object({
  emailProvider: z.enum(["mock", "smtp", "gmail"]),
  smtpHost: optionalText,
  smtpPort: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number.parseInt(v, 10)))
    .refine((v) => v === null || (Number.isFinite(v) && v > 0 && v <= 65535), "SMTP port must be 1–65535."),
  smtpSecure: checkboxInput,
  smtpUser: optionalText,
  smtpPassword: optionalText,
  smtpFromName: optionalText,
  smtpFromEmail: optionalText,
  whatsappProvider: z.enum(["mock", "twilio", "gupshup", "meta"]),
  whatsappApiUrl: optionalText,
  whatsappApiKey: optionalText,
  whatsappSenderId: optionalText,
});

export async function saveCommunicationAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const parsed = communicationSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const data = { ...parsed.data };
    // A blank secret means "leave unchanged" rather than "clear it".
    const current = await prisma.communicationConfig.findUnique({ where: { id: 1 } });
    if (!data.smtpPassword && current?.smtpPassword) data.smtpPassword = current.smtpPassword;
    if (!data.whatsappApiKey && current?.whatsappApiKey) data.whatsappApiKey = current.whatsappApiKey;

    if (data.emailProvider === "smtp" && !data.smtpHost) {
      return fail("SMTP host is required when the email provider is SMTP.", {
        smtpHost: ["Required for SMTP delivery."],
      });
    }
    if (data.emailProvider === "gmail") {
      // Host and port are fixed for Gmail, so the only things that can be wrong
      // are the address and the App Password — check both here rather than
      // letting Gmail answer with a bare 535.
      if (!data.smtpUser) {
        return fail("Enter the Gmail address to send from.", { smtpUser: ["Required for Gmail."] });
      }
      if (!data.smtpPassword) {
        return fail("Gmail needs an App Password.", {
          smtpPassword: ["Required for Gmail — generate a 16-character App Password."],
        });
      }
      // Google shows App Passwords in four groups of four; people paste them
      // with the spaces in. Strip them rather than failing on an invisible character.
      data.smtpPassword = data.smtpPassword.replaceAll(/\s+/g, "");
      if (data.smtpPassword.length !== 16) {
        return fail("That does not look like a Gmail App Password.", {
          smtpPassword: ["An App Password is exactly 16 characters — not your account password."],
        });
      }
    }
    if (data.whatsappProvider !== "mock" && !data.whatsappApiUrl) {
      return fail("WhatsApp API URL is required for a live provider.", {
        whatsappApiUrl: ["Required for a live provider."],
      });
    }

    await prisma.communicationConfig.upsert({
      where: { id: 1 },
      update: data,
      create: { id: 1, ...data },
    });

    await recordAudit({
      userId: user.id,
      action: "institute.communication_updated",
      entityType: "CommunicationConfig",
      entityId: "1",
      summary: `Communication providers set to email=${data.emailProvider}, whatsapp=${data.whatsappProvider}`,
    });
    revalidatePath("/setup/communication");
    return ok(undefined, "Communication settings saved.");
  });
}

/**
 * Send a test email with the saved settings.
 *
 * Worth its own button: a wrong App Password otherwise stays invisible until a
 * family reports never receiving their welcome kit, and the failure surfaces
 * only in the notification log.
 */
export async function sendTestEmailAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const to = String(formData.get("testTo") ?? "").trim();
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return fail("Enter an address to send the test to.", { testTo: ["Enter a valid email address."] });
    }

    const config = await getCommunicationConfig();
    if (!emailIsLive(config)) {
      return fail("The email provider is set to Mock — nothing would be delivered. Choose Gmail or SMTP and save first.");
    }

    const institute = await getInstitute().catch(() => null);
    const result = await deliverEmail({
      kind: "DOCUMENT",
      to,
      subject: `Test email from ${institute?.name ?? "the institute ERP"}`,
      body:
        "This is a test message from your institute ERP.\n\n" +
        "If you are reading it, the email gateway is configured correctly and receipts, welcome kits, ledgers and " +
        "reports can be emailed from the app.",
    });

    await recordAudit({
      userId: user.id,
      action: "institute.email_test",
      entityType: "CommunicationConfig",
      entityId: "1",
      summary: `Test email to ${to} ${result.ok ? "succeeded" : "failed"}`,
    });

    return result.ok
      ? ok(undefined, `Test email sent to ${to}. Check the inbox — and the spam folder.`)
      : fail(result.error);
  });
}

/* -------------------------------------------------------------------------- */
/* Academic years                                                              */
/* -------------------------------------------------------------------------- */

const academicYearSchema = z
  .object({
    id: optionalText,
    name: requiredText("Academic year name", 4),
    startDate: dateInput("Start date"),
    endDate: dateInput("End date"),
    isCurrent: checkboxInput,
  })
  .refine((data) => data.endDate > data.startDate, {
    message: "End date must be after the start date.",
    path: ["endDate"],
  });

export async function saveAcademicYearAction(_prev: unknown, formData: FormData): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const parsed = academicYearSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { id, isCurrent, ...data } = parsed.data;

    const duplicate = await prisma.academicYear.findFirst({
      where: { name: data.name, ...(id ? { NOT: { id } } : {}) },
    });
    if (duplicate) return fail("An academic year with that name already exists.", { name: ["Already in use."] });

    await prisma.$transaction(async (tx) => {
      // Exactly one year can be current.
      if (isCurrent) {
        await tx.academicYear.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
      }
      if (id) {
        await tx.academicYear.update({ where: { id }, data: { ...data, isCurrent } });
      } else {
        await tx.academicYear.create({ data: { ...data, isCurrent } });
      }
    });

    await recordAudit({
      userId: user.id,
      action: "institute.academic_year_saved",
      entityType: "AcademicYear",
      entityId: id,
      summary: `Academic year ${data.name} saved${isCurrent ? " and set as current" : ""}`,
    });
    revalidatePath("/setup/academic-years");
    return ok(undefined, "Academic year saved.");
  });
}

/* -------------------------------------------------------------------------- */
/* 1.3 Document checklist                                                      */
/* -------------------------------------------------------------------------- */

const documentSchema = z.object({
  id: optionalText,
  code: requiredText("Code", 2).regex(/^[A-Z0-9_]+$/, "Use uppercase letters, digits and underscores only."),
  label: requiredText("Label", 2),
  isRequired: checkboxInput,
  sortOrder: intInput("Sort order", { min: 0, max: 999 }),
});

export async function saveDocumentRequirementAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const parsed = documentSchema.safeParse(formObject(formData));
    if (!parsed.success) return fail("Please correct the highlighted fields.", fieldErrorsOf(parsed.error));

    const { id, ...data } = parsed.data;
    const duplicate = await prisma.documentRequirement.findFirst({
      where: { code: data.code, ...(id ? { NOT: { id } } : {}) },
    });
    if (duplicate) return fail("That code is already used.", { code: ["Already in use."] });

    if (id) {
      await prisma.documentRequirement.update({ where: { id }, data });
    } else {
      await prisma.documentRequirement.create({ data });
    }

    await recordAudit({
      userId: user.id,
      action: "institute.document_requirement_saved",
      entityType: "DocumentRequirement",
      entityId: id,
      summary: `Document checklist item ${data.code} saved`,
    });
    revalidatePath("/setup/documents");
    return ok(undefined, "Checklist item saved.");
  });
}

export async function toggleDocumentRequirementAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return runAction(async () => {
    const user = await assertPermission(PERMISSIONS.INSTITUTE_MANAGE);
    const id = String(formData.get("id") ?? "");
    const item = await prisma.documentRequirement.findUnique({ where: { id } });
    if (!item) return fail("Checklist item not found.");

    await prisma.documentRequirement.update({ where: { id }, data: { isActive: !item.isActive } });
    await recordAudit({
      userId: user.id,
      action: "institute.document_requirement_toggled",
      entityType: "DocumentRequirement",
      entityId: id,
      summary: `Document checklist item ${item.code} ${item.isActive ? "deactivated" : "reactivated"}`,
    });
    revalidatePath("/setup/documents");
    return ok(undefined, item.isActive ? "Item deactivated." : "Item reactivated.");
  });
}
