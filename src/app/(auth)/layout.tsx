import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    // A crimson wash behind the card, with two soft blooms placed off-centre so
    // the sign-in screen reads as composed rather than empty.
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-12">
      <span
        className="pointer-events-none absolute -left-32 -top-28 h-96 w-96 rounded-full bg-crimson-200/50 blur-3xl"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute -bottom-32 -right-24 h-[28rem] w-[28rem] rounded-full bg-crimson-100/70 blur-3xl"
        aria-hidden
      />
      <div className="animate-rise relative w-full max-w-md">{children}</div>
    </div>
  );
}
