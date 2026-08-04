"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight, Menu, X } from "lucide-react";
import { sectionContains, type NavSection } from "@/lib/nav";
import { cn } from "@/lib/cn";

function matches(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** "Priya Sharma" → "PS", for the header badge. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/**
 * The most specific matching link wins, so "/students/import" highlights
 * "Bulk import" rather than also lighting up its "/students" sibling.
 */
function activeHref(pathname: string, sections: NavSection[]): string | null {
  let best: string | null = null;
  for (const section of sections) {
    for (const item of section.items) {
      if (matches(pathname, item.href) && (!best || item.href.length > best.length)) {
        best = item.href;
      }
    }
  }
  return best;
}

export function AppShell({
  sections,
  instituteName,
  user,
  children,
  signOut,
}: {
  sections: NavSection[];
  instituteName: string;
  user: { name: string; roleName: string };
  children: ReactNode;
  signOut: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const active = activeHref(pathname, sections);

  /**
   * Which sections are shut. Every header is a toggle; only the starting state
   * differs. Collapsing sticks for the session rather than resetting on the
   * next click — a sidebar you have to tidy again after every navigation is not
   * worth tidying.
   */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sections.filter((s) => s.defaultCollapsed).map((s) => [s.label, true])),
  );

  // Opening the section you have just navigated into, so you are never left on
  // a page whose own nav entry is hidden. Adjusted during render rather than in
  // an effect: this is the "state derived from a changed prop" case, and an
  // effect would cost a second render.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    const entered = sections.find((section) => sectionContains(section, pathname));
    if (entered && collapsed[entered.label]) {
      setCollapsed((current) => ({ ...current, [entered.label]: false }));
    }
  }

  const isExpanded = (section: NavSection) => !collapsed[section.label];

  return (
    <div className="flex min-h-screen">
      {open ? (
        <button
          type="button"
          aria-label="Close menu"
          className="animate-fade fixed inset-0 z-30 bg-crimson-950/40 backdrop-blur-sm lg:hidden"
          onClick={() => setOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          "no-print fixed inset-y-0 left-0 z-40 w-64 shrink-0 overflow-y-auto border-r border-border bg-surface",
          "shadow-card transition-transform duration-200 lg:static lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* The institute's name reversed out of the brand — the one place the
            colour is used at full strength, so it anchors everything else. */}
        <div className="brand-gradient sticky top-0 z-10 flex h-14 items-center justify-between gap-2 px-4">
          <span className="truncate text-sm font-semibold tracking-tight text-brand-fg">{instituteName}</span>
          <button
            type="button"
            className="rounded-md p-1 text-brand-fg/80 transition-colors hover:bg-white/15 hover:text-brand-fg lg:hidden"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="p-3">
          {sections.map((section) => {
            const expanded = isExpanded(section);
            const listId = `nav-${section.label.toLowerCase().replace(/\s+/g, "-")}`;

            return (
              <div key={section.label} className="mb-4">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => setCollapsed((current) => ({ ...current, [section.label]: expanded }))}
                  className={cn(
                    "flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase",
                    "tracking-wider text-muted transition-colors hover:bg-brand-soft hover:text-brand-strong",
                  )}
                >
                  <span className="transition-transform duration-200" aria-hidden>
                    {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                  </span>
                  {section.label}
                  {/* A collapsed section still says when the page you are on
                      lives inside it. */}
                  {!expanded && section.items.some((item) => item.href === active) ? (
                    <span className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand ring-4 ring-crimson-100" aria-hidden />
                  ) : null}
                </button>

                {expanded ? (
                  <ul id={listId} className="animate-fade mt-0.5 space-y-0.5">
                    {section.items.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={() => setOpen(false)}
                          className={cn(
                            // Indented under the toggle, so items read as
                            // belonging to the section that opened them. The
                            // page you are on grows a crimson spine and slides
                            // a hair to meet it.
                            "relative block rounded-lg py-1.5 pl-5 pr-2 text-sm transition-all duration-150",
                            "before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full",
                            "before:bg-brand before:transition-all before:duration-200",
                            active === item.href
                              ? "bg-brand-soft font-medium text-brand-strong before:opacity-100"
                              : "text-foreground before:opacity-0 hover:translate-x-0.5 hover:bg-brand-soft/70 hover:text-brand-strong",
                          )}
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "no-print sticky top-0 z-20 flex h-14 items-center justify-between gap-3 px-4",
            "border-b border-border bg-surface/85 backdrop-blur-md supports-[backdrop-filter]:bg-surface/70",
          )}
        >
          <button
            type="button"
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-brand-soft hover:text-brand-strong lg:hidden"
            aria-label="Open menu"
            onClick={() => setOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-sm font-medium">{user.name}</p>
              <p className="text-xs text-muted">{user.roleName}</p>
            </div>
            {/* Initials in the brand: identity without an avatar upload. */}
            <span
              className="brand-gradient flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-brand-fg shadow-brand"
              title={`${user.name} · ${user.roleName}`}
              aria-hidden
            >
              {initials(user.name)}
            </span>
            {signOut}
          </div>
        </header>
        {/* Keyed on the path so each page fades in as you arrive. */}
        <main key={pathname} className="animate-rise min-w-0 flex-1 p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
