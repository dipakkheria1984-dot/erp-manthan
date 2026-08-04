"use client";

import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Alert, Button, Field, Textarea, buttonClass } from "@/components/ui";
import type { ActionResult } from "@/lib/errors";
import { cn } from "@/lib/cn";

/** Submit button that shows a pending state while the server action runs. */
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  size = "md",
  className,
  disabled,
  formAction,
  name,
  value,
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  className?: string;
  disabled?: boolean;
  formAction?: (formData: FormData) => void | Promise<void>;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      formAction={formAction}
      disabled={pending || disabled}
      className={buttonClass(variant, size, className)}
    >
      {pending ? (pendingLabel ?? "Working…") : children}
    </button>
  );
}

export type FormState = ActionResult<unknown> | null;

export const emptyFormState: FormState = null;

/** Renders the error/success banner produced by a server action. */
export function FormFeedback({ state }: { state: FormState }) {
  if (!state) return null;
  if (state.ok) {
    return state.message ? (
      <Alert tone="success">{state.message}</Alert>
    ) : null;
  }
  return (
    <Alert tone="danger" title="Could not save">
      {state.error}
    </Alert>
  );
}

export function fieldError(state: FormState, name: string): string | undefined {
  if (!state || state.ok) return undefined;
  return state.fieldErrors?.[name]?.[0];
}

/**
 * A form wired to a server action via `useActionState`, with feedback rendered
 * above the fields. `children` receives the current state so individual fields
 * can show their own errors.
 */
export function ActionForm({
  action,
  children,
  className,
  onSuccess,
  resetOnSuccess,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  children: ReactNode | ((state: FormState) => ReactNode);
  className?: string;
  onSuccess?: (state: ActionResult<unknown>) => void;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction] = useActionState(action, emptyFormState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok) {
      if (resetOnSuccess) formRef.current?.reset();
      onSuccess?.(state);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className={cn("space-y-4", className)}>
      <FormFeedback state={state} />
      {typeof children === "function" ? children(state) : children}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Dialogs                                                                     */
/* -------------------------------------------------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  width = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  width?: "sm" | "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const widthClass = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl" }[width];

  return (
    <div className="animate-fade fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-crimson-950/40 p-4 backdrop-blur-sm sm:p-8">
      <button type="button" aria-label="Close" className="fixed inset-0 cursor-default" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "animate-rise relative w-full overflow-hidden rounded-2xl border border-border bg-surface",
          "shadow-modal",
          widthClass,
        )}
      >
        <header className="brand-gradient-soft relative border-b border-border px-5 py-4">
          <span className="brand-rule pointer-events-none absolute inset-x-0 top-0 h-1" aria-hidden />
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/**
 * Button that opens a modal demanding a written reason before submitting.
 * Used by every action the spec requires a logged reason for — approvals,
 * rejections, status changes, receipt cancellation, waiver changes.
 */
export function ReasonActionButton({
  action,
  label,
  title,
  description,
  confirmLabel,
  reasonLabel = "Reason",
  reasonPlaceholder,
  variant = "primary",
  size = "md",
  hidden,
  minLength = 5,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  label: ReactNode;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  /** Extra hidden inputs passed through to the action. */
  hidden?: Record<string, string>;
  minLength?: number;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <>
      <Button type="button" variant={variant} size={size} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} description={description}>
        <ActionForm action={action} onSuccess={() => setOpen(false)}>
          {(state) => (
            <>
              {Object.entries(hidden ?? {}).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              <Field label={reasonLabel} htmlFor={id} required error={fieldError(state, "reason")}>
                <Textarea id={id} name="reason" required minLength={minLength} placeholder={reasonPlaceholder} />
              </Field>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton variant={variant === "ghost" ? "primary" : variant}>
                  {confirmLabel ?? "Confirm"}
                </SubmitButton>
              </div>
            </>
          )}
        </ActionForm>
      </Modal>
    </>
  );
}
