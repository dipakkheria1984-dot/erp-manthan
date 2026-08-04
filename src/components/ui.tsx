import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="animate-rise mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
      <div className="min-w-0">
        {/* The upright crimson stroke is the app's signature mark: it heads every
            page, and nothing else in the layout uses it. */}
        <div className="flex items-start gap-3">
          <span className="brand-gradient mt-1 h-7 w-1 shrink-0 rounded-full" aria-hidden />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
            {description ? <div className="mt-1.5 max-w-3xl text-sm text-muted">{description}</div> : null}
          </div>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "animate-rise group/card relative overflow-hidden rounded-xl border border-border bg-surface",
        "shadow-card transition-shadow duration-200 hover:shadow-lift",
        className,
      )}
    >
      {title || actions ? (
        <header className="brand-gradient-soft relative flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          {/* A thread of crimson along the top edge, brightest at the title. */}
          <span className="brand-rule pointer-events-none absolute inset-x-0 top-0 h-0.5" aria-hidden />
          <div className="min-w-0">
            {title ? <h2 className="text-base font-semibold tracking-tight">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  // Each tone owns a value colour and the bar above it, so a figure's standing
  // is readable at a glance across a row of tiles.
  const tones = {
    default: { value: "text-foreground", bar: "brand-gradient", glow: "bg-crimson-100" },
    success: { value: "text-success", bar: "bg-success", glow: "bg-success-soft" },
    warning: { value: "text-warning", bar: "bg-warning", glow: "bg-warning-soft" },
    danger: { value: "text-danger", bar: "bg-danger", glow: "bg-danger-soft" },
  }[tone];

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border bg-surface px-5 py-4",
        "shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lift",
      )}
    >
      <span className={cn("absolute inset-x-0 top-0 h-1", tones.bar)} aria-hidden />
      {/* A soft bloom in the corner, which lifts as the tile is hovered. */}
      <span
        className={cn(
          "pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full opacity-60 blur-2xl transition-opacity duration-300 group-hover:opacity-100",
          tones.glow,
        )}
        aria-hidden
      />
      <p className="relative text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className={cn("relative mt-1.5 text-2xl font-semibold tabular-nums tracking-tight", tones.value)}>{value}</p>
      {hint ? <p className="relative mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="animate-fade flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-surface-muted px-6 py-12 text-center">
      <span className="brand-gradient mb-1 h-1.5 w-10 rounded-full opacity-70" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Buttons                                                                     */
/* -------------------------------------------------------------------------- */

const buttonVariants = {
  primary:
    "brand-gradient text-brand-fg shadow-brand hover:brightness-110 " +
    "disabled:bg-none disabled:bg-crimson-200 disabled:text-white disabled:shadow-none",
  secondary:
    "border border-border bg-surface text-foreground hover:border-crimson-200 hover:bg-brand-soft hover:text-brand-strong " +
    "disabled:text-muted disabled:hover:border-border disabled:hover:bg-surface",
  danger: "bg-danger text-white hover:brightness-110 disabled:bg-danger/40 disabled:text-white",
  ghost: "text-foreground hover:bg-brand-soft hover:text-brand-strong disabled:text-muted disabled:hover:bg-transparent",
} as const;

const buttonSizes = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
} as const;

export function buttonClass(
  variant: keyof typeof buttonVariants = "primary",
  size: keyof typeof buttonSizes = "md",
  className?: string,
): string {
  return cn(
    "inline-flex select-none items-center justify-center gap-1.5 rounded-lg font-medium",
    // Presses in by a hair — the whole feedback loop of a click, for one line.
    "transition-all duration-150 active:translate-y-px active:brightness-95",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
    "disabled:cursor-not-allowed disabled:active:translate-y-0 disabled:hover:brightness-100",
    buttonVariants[variant],
    buttonSizes[size],
    className,
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof buttonVariants; size?: keyof typeof buttonSizes }) {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

export function LinkButton({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: keyof typeof buttonVariants; size?: keyof typeof buttonSizes }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* Form primitives                                                             */
/* -------------------------------------------------------------------------- */

const controlClass =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm shadow-[0_1px_1px_rgba(64,3,19,0.04)] " +
  "transition-colors duration-150 placeholder:text-muted/70 hover:border-border-strong " +
  "focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/25 " +
  "disabled:bg-background disabled:text-muted";

export function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string | string[];
  children: ReactNode;
  className?: string;
}) {
  const message = Array.isArray(error) ? error[0] : error;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
        {required ? <span className="ml-0.5 text-danger">*</span> : null}
      </label>
      {children}
      {hint && !message ? <p className="text-xs text-muted">{hint}</p> : null}
      {message ? <p className="text-xs text-danger">{message}</p> : null}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(controlClass, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(controlClass, "min-h-20", className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(controlClass, "pr-8", className)} {...props} />;
}

export function Checkbox({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      className={cn(
        "h-4 w-4 cursor-pointer rounded border-border-strong text-brand accent-[var(--brand)]",
        "transition-shadow focus:ring-4 focus:ring-brand/25",
        className,
      )}
      {...props}
    />
  );
}

export function FormGrid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 | 4 }) {
  const colClass = { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" }[cols];
  return <div className={cn("grid grid-cols-1 gap-4", colClass)}>{children}</div>;
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-border pt-4">{children}</div>;
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: ReactNode;
  children?: ReactNode;
}) {
  // The left edge carries the tone at full strength while the panel stays pale,
  // so a stack of notices is scannable without shouting.
  const tones = {
    info: "border-info/20 bg-info-soft text-info [&>span]:bg-info",
    success: "border-success/20 bg-success-soft text-success [&>span]:bg-success",
    warning: "border-warning/20 bg-warning-soft text-warning [&>span]:bg-warning",
    danger: "border-danger/20 bg-danger-soft text-danger [&>span]:bg-danger",
  } as const;
  return (
    <div
      className={cn("animate-fade relative overflow-hidden rounded-lg border py-3 pl-5 pr-4 text-sm", tones[tone])}
      role="status"
    >
      <span className="absolute inset-y-0 left-0 w-1.5" aria-hidden />
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cn("text-foreground/80", title && "mt-1")}>{children}</div> : null}
    </div>
  );
}

const badgeTones = {
  neutral: "bg-surface-muted text-muted ring-border-strong [&>i]:bg-muted",
  info: "bg-info-soft text-info ring-info/20 [&>i]:bg-info",
  success: "bg-success-soft text-success ring-success/20 [&>i]:bg-success",
  warning: "bg-warning-soft text-warning ring-warning/20 [&>i]:bg-warning",
  danger: "bg-danger-soft text-danger ring-danger/20 [&>i]:bg-danger",
  brand: "bg-brand-soft text-brand-strong ring-crimson-200 [&>i]:bg-brand",
} as const;

export type BadgeTone = keyof typeof badgeTones;

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap",
        badgeTones[tone],
      )}
    >
      {/* The dot does the colour-coding, so the label stays readable at 12px. */}
      <i className="h-1.5 w-1.5 shrink-0 rounded-full" aria-hidden />
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-card">
      <table className="w-full min-w-max border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "border-b border-border bg-brand-soft px-4 py-3 text-left text-xs font-semibold uppercase",
        "tracking-wider text-brand-deep",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("border-b border-border px-4 py-2.5 align-middle", className)} {...props} />;
}

export function Tr({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        // The row you are reading tints and grows a crimson edge, which is how
        // you keep your place across a wide fee table.
        "group/row relative transition-colors duration-150 even:bg-surface-muted/60 hover:bg-brand-soft",
        "hover:[box-shadow:inset_3px_0_0_0_var(--brand)]",
        className,
      )}
      {...props}
    />
  );
}

export function DescriptionList({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((item, i) => (
        <div key={i}>
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">{item.label}</dt>
          <dd className="mt-0.5 text-sm">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
