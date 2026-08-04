import { z } from "zod";
import { rupeesToPaise } from "@/lib/money";
import { fromDateInput } from "@/lib/dates";

/** Trimmed string that becomes `undefined` when the field was left blank. */
export const optionalText = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : v))
  .optional();

export const requiredText = (label: string, min = 1) =>
  z.string().trim().min(min, `${label} is required.`);

/** A rupee amount typed by a user, stored as paise. */
export const rupeeAmount = (label: string, { min = 0 }: { min?: number } = {}) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .refine((v) => Number.isFinite(Number(v.replace(/,/g, ""))), `${label} must be a number.`)
    .transform((v) => rupeesToPaise(v))
    .refine((paise) => paise >= min, `${label} cannot be less than ${min / 100}.`);

/**
 * A rupee amount that may be left blank, or not submitted at all — a form that
 * shows the field only for one choice (a scholarship quoted as a flat figure,
 * say) posts nothing for it otherwise. Both mean zero.
 *
 * The missing-key case needs `preprocess`: a bare `.transform()` on a string
 * still makes the key required, so an absent field fails with "expected string,
 * received undefined" against an input the user never saw.
 */
export const optionalRupeeAmount = (label: string) =>
  z.preprocess(
    (v) => (v === undefined || v === null ? "" : v),
    z
      .string()
      .trim()
      .transform((v) => (v === "" ? 0 : rupeesToPaise(v)))
      .refine((paise) => paise >= 0, `${label} cannot be negative.`),
  );

/** `yyyy-MM-dd` from <input type="date">, parsed as local midnight. */
export const dateInput = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .refine((v) => !Number.isNaN(fromDateInput(v).getTime()), `${label} is not a valid date.`)
    .transform((v) => fromDateInput(v));

export const optionalDateInput = z
  .string()
  .trim()
  .transform((v) => (v === "" ? undefined : fromDateInput(v)))
  .optional();

export const intInput = (label: string, { min, max }: { min?: number; max?: number } = {}) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .refine((v) => /^-?\d+$/.test(v), `${label} must be a whole number.`)
    .transform((v) => Number.parseInt(v, 10))
    .refine((n) => (min === undefined ? true : n >= min), `${label} must be at least ${min}.`)
    .refine((n) => (max === undefined ? true : n <= max), `${label} must be at most ${max}.`);

/**
 * The same for a whole number: blank, or not submitted at all, is `undefined`
 * rather than an error. Use it wherever "none" is a legitimate answer — a 0%
 * scholarship, for instance, whether it was typed as 0 or left empty.
 */
export const optionalIntInput = (label: string, range: { min?: number; max?: number } = {}) =>
  z
    .string()
    .trim()
    .transform((v) => (v === "" ? undefined : v))
    .optional()
    .pipe(intInput(label, range).optional());

/**
 * An unchecked checkbox is simply absent from FormData, so this must stay
 * optional at the object level — a union that merely *includes* `z.undefined()`
 * is still treated as a required key by Zod and rejects the missing value.
 */
export const checkboxInput = z
  .unknown()
  .optional()
  .transform((v) => v === "on" || v === "true" || v === true);

/** Reason/remark required by the spec for sensitive actions. */
export const reasonInput = z
  .string()
  .trim()
  .min(5, "Please give a reason of at least 5 characters — it is recorded in the audit trail.")
  .max(1000, "Reason is too long.");

/** Collect a FormData into a plain object for zod parsing. */
export function formObject(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) continue;
    if (key in out) {
      const existing = out[key];
      out[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function fieldErrorsOf(error: z.ZodError): Record<string, string[]> {
  return z.flattenError(error).fieldErrors as Record<string, string[]>;
}
