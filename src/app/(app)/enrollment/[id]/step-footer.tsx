import { LinkButton } from "@/components/ui";

type Step = { href: string; label: string };

/**
 * Wizard navigation for steps 1–5. The tab strip above is the map; this is the
 * "what next" every step needs so a clerk is never stranded mid-application.
 */
export function StepFooter({ back, next }: { back?: Step; next?: Step }) {
  return (
    <div className="no-print flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
      {back ? (
        <LinkButton href={back.href} variant="secondary">
          ← {back.label}
        </LinkButton>
      ) : (
        <span />
      )}
      {next ? <LinkButton href={next.href}>{next.label} →</LinkButton> : <span />}
    </div>
  );
}
