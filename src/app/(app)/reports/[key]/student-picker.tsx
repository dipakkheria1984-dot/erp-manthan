"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";

type Option = { id: string; name: string };

/**
 * Type-to-search replacement for the student dropdown on the Student Ledger.
 *
 * A plain `<select>` means scrolling several hundred names to reach one, so the
 * visible control is a search box and the chosen student is carried in a hidden
 * input under the field's real name. Matching is on the whole label — student
 * code and name both — because staff search by either.
 */
export function StudentPicker({
  name,
  id,
  students,
  defaultValue,
  placeholder = "Search by name or student ID…",
}: {
  name: string;
  id: string;
  students: Option[];
  defaultValue?: string;
  placeholder?: string;
}) {
  const selectedFromDefault = students.find((s) => s.id === defaultValue) ?? null;
  const [selected, setSelected] = useState<Option | null>(selectedFromDefault);
  const [query, setQuery] = useState(selectedFromDefault?.name ?? "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // An unedited selection should not filter the list down to itself — the
    // point of reopening is usually to pick somebody else.
    if (!needle || needle === selected?.name.toLowerCase()) return students;
    const terms = needle.split(/\s+/);
    return students.filter((student) => {
      const haystack = student.name.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [query, students, selected]);

  // Long result sets are the thing being fixed, so only ever draw a window of
  // them and tell the user how many more there are.
  const shown = matches.slice(0, 50);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const choose = (student: Option) => {
    setSelected(student);
    setQuery(student.name);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setHighlight((current) => {
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        return Math.max(0, Math.min(next, shown.length - 1));
      });
      return;
    }
    if (event.key === "Enter" && open && shown[highlight]) {
      // Enter picks the highlighted row rather than submitting a half-typed name.
      event.preventDefault();
      choose(shown[highlight]);
      return;
    }
    if (event.key === "Escape") setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        aria-autocomplete="list"
        autoComplete="off"
        className={cn(
          "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm",
          "shadow-[0_1px_1px_rgba(16,24,40,0.04)]",
          "focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20",
        )}
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(null);
          setHighlight(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {open ? (
        <ul
          id={`${id}-options`}
          role="listbox"
          className={cn(
            "absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-border",
            "bg-surface py-1 shadow-lg",
          )}
        >
          {shown.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">No student matches “{query.trim()}”.</li>
          ) : (
            <>
              {shown.map((student, index) => (
                <li key={student.id} role="option" aria-selected={student.id === selected?.id}>
                  <button
                    type="button"
                    className={cn(
                      "block w-full px-3 py-1.5 text-left text-sm",
                      index === highlight ? "bg-brand/10" : "hover:bg-background",
                      student.id === selected?.id ? "font-medium" : "",
                    )}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => choose(student)}
                  >
                    {student.name}
                  </button>
                </li>
              ))}
              {matches.length > shown.length ? (
                <li className="border-t border-border px-3 py-1.5 text-xs text-muted">
                  {matches.length - shown.length} more — keep typing to narrow it down.
                </li>
              ) : null}
            </>
          )}
        </ul>
      ) : null}
    </div>
  );
}
