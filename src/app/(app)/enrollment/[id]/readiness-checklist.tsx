import Link from "next/link";
import { Badge } from "@/components/ui";
import type { ReadinessItem } from "@/lib/enrollment";

/**
 * The submission checklist. Optional items (documents, and anything else the
 * institute collects but does not insist on) are shown in a neutral tone so a
 * clerk can tell at a glance what actually blocks submission.
 */
export function ReadinessChecklist({ items }: { items: ReadinessItem[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const blocking = !item.done && !item.optional;
        return (
          <li key={item.key} className="flex items-start gap-3">
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
                item.done ? "bg-green-100 text-success" : blocking ? "bg-amber-100 text-warning" : "bg-background text-muted"
              }`}
              aria-hidden
            >
              {item.done ? "✓" : blocking ? "!" : "–"}
            </span>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {item.href ? (
                  <Link href={item.href} className="hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  item.label
                )}
                {item.optional ? <Badge>Optional</Badge> : null}
              </p>
              {!item.done && item.detail ? <p className="text-xs text-muted">{item.detail}</p> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
