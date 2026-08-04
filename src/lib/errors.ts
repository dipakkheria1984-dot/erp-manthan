/**
 * Domain errors. Server actions catch these and surface `message` to the user;
 * anything else is logged and replaced with a generic message so internals
 * (including hidden config values) never leak to the UI.
 */

export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string = "APP_ERROR",
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string[]> = {},
  ) {
    super(message, "VALIDATION_ERROR", 422);
    this.name = "ValidationError";
  }
}

export class AuthError extends AppError {
  constructor(message = "You must sign in to continue.") {
    super(message, "AUTH_ERROR", 401);
    this.name = "AuthError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.") {
    super(message, "FORBIDDEN", 403);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(what = "Record") {
    super(`${what} not found.`, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export function ok<T>(data: T, message?: string): ActionResult<T> {
  return { ok: true, data, message };
}

export function fail(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

/**
 * Wrap a server action body so domain errors become friendly results and
 * unexpected errors are logged without leaking details.
 */
export async function runAction<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ValidationError) {
      return fail(error.message, error.fieldErrors);
    }
    if (error instanceof AppError) {
      return fail(error.message);
    }
    console.error("[action]", error);
    return fail("Something went wrong. Please try again.");
  }
}
