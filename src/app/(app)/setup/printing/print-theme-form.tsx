"use client";

import { useMemo, useState } from "react";
import type { Institute } from "@/generated/prisma/client";
import { ActionForm, SubmitButton, fieldError } from "@/components/form";
import { Alert, Card, Field, FormActions, Input, buttonClass } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  DEFAULT_COLOR_SCHEME_ID,
  DEFAULT_THEME_ID,
  PRINT_COLOR_SCHEMES,
  PRINT_THEMES,
  normalizeHex,
  resolvePrintStyle,
} from "@/lib/print-theme";
import { savePrintThemeAction } from "../actions";

/**
 * Colour scheme and theme picker for printed material.
 *
 * The preview is rendered from `resolvePrintStyle` — the same function the PDF
 * renderer uses — so what the admin sees on screen is what pdfkit will paint,
 * rather than a mock-up maintained separately that quietly drifts from it.
 */
export function PrintThemeForm({ institute }: { institute: Institute | null }) {
  const [scheme, setScheme] = useState(institute?.printColorScheme ?? DEFAULT_COLOR_SCHEME_ID);
  const [theme, setTheme] = useState(institute?.printTheme ?? DEFAULT_THEME_ID);
  const [accent, setAccent] = useState(institute?.printAccentHex ?? "#1d4ed8");

  const style = useMemo(
    () => resolvePrintStyle({ printColorScheme: scheme, printTheme: theme, printAccentHex: accent }),
    [scheme, theme, accent],
  );

  // The sample PDF is generated from the current selection rather than what is
  // saved, so the admin can try a scheme on a real receipt before committing.
  const sampleHref = `/api/print-preview?${new URLSearchParams({
    scheme,
    theme,
    ...(normalizeHex(accent) ? { accent: normalizeHex(accent)! } : {}),
  })}`;

  return (
    <ActionForm action={savePrintThemeAction} className="space-y-6">
      {(state) => (
        <>
          {institute ? null : (
            <Alert tone="warning" title="No institute profile yet">
              Save the institute profile first — the print appearance is stored alongside it.
            </Alert>
          )}

          <input type="hidden" name="printColorScheme" value={scheme} />
          <input type="hidden" name="printTheme" value={theme} />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="space-y-6">
              <Card
                title="Colour scheme"
                description="One accent colour, from which the rest of the palette is derived."
              >
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {PRINT_COLOR_SCHEMES.map((option) => {
                    const swatch =
                      option.accent ?? (normalizeHex(accent) ?? "#1d4ed8");
                    const selected = option.id === scheme;
                    return (
                      <button
                        type="button"
                        key={option.id}
                        onClick={() => setScheme(option.id)}
                        aria-pressed={selected}
                        title={option.description}
                        className={cn(
                          "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                          selected
                            ? "border-brand ring-2 ring-brand/20"
                            : "border-border hover:bg-background",
                        )}
                      >
                        <span
                          className="h-8 w-8 shrink-0 rounded-md border border-black/10"
                          style={{ backgroundColor: swatch }}
                          aria-hidden
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{option.label}</span>
                          <span className="block truncate text-xs text-muted">
                            {option.id === "custom" ? "Your own hex code" : swatch}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                <p className="mt-3 text-xs text-muted">{PRINT_COLOR_SCHEMES.find((s) => s.id === scheme)?.description}</p>

                {scheme === "custom" ? (
                  <div className="mt-4 max-w-sm">
                    <Field
                      label="Accent colour"
                      htmlFor="printAccentHex"
                      required
                      hint="Hex code, e.g. #1d4ed8. Headings, rules and table headers derive from it."
                      error={fieldError(state, "printAccentHex")}
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          aria-label="Pick accent colour"
                          value={normalizeHex(accent) ?? "#1d4ed8"}
                          onChange={(event) => setAccent(event.target.value)}
                          className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-border bg-surface p-1"
                        />
                        <Input
                          id="printAccentHex"
                          name="printAccentHex"
                          value={accent}
                          onChange={(event) => setAccent(event.target.value)}
                          placeholder="#1d4ed8"
                          spellCheck={false}
                        />
                      </div>
                    </Field>
                  </div>
                ) : (
                  // Still submitted on the other schemes so a custom colour the
                  // admin already entered survives a trip through another scheme.
                  // Normalised first: half-typed text is ignored here rather than
                  // failing validation against a field that is no longer on screen.
                  <input type="hidden" name="printAccentHex" value={normalizeHex(accent) ?? ""} />
                )}
              </Card>

              <Card title="Theme" description="How the letterhead, headings, rules and tables are laid out.">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {PRINT_THEMES.map((option) => {
                    const selected = option.id === theme;
                    return (
                      <button
                        type="button"
                        key={option.id}
                        onClick={() => setTheme(option.id)}
                        aria-pressed={selected}
                        className={cn(
                          "flex items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors",
                          selected ? "border-brand ring-2 ring-brand/20" : "border-border hover:bg-background",
                        )}
                      >
                        <ThemeGlyph theme={option.id} accent={style.palette.accent} tint={style.palette.tint} />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{option.label}</span>
                          <span className="mt-0.5 block text-xs text-muted">{option.description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Card>
            </div>

            <div className="lg:sticky lg:top-6 lg:self-start">
              <Card title="Preview" description="A fee receipt letterhead in the selected combination.">
                <Preview institute={institute} style={style} />
                <a
                  href={sampleHref}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonClass("secondary", "sm", "mt-4 w-full")}
                >
                  Open sample PDF
                </a>
                <p className="mt-2 text-xs text-muted">
                  The sample uses the selection above, saved or not. Saving applies it to every document generated from
                  then on; documents already printed are unaffected.
                </p>
              </Card>
            </div>
          </div>

          <Card>
            <FormActions>
              <SubmitButton pendingLabel="Saving…" disabled={!institute}>
                Save print appearance
              </SubmitButton>
            </FormActions>
          </Card>
        </>
      )}
    </ActionForm>
  );
}

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

/** Thumbnail of a theme's letterhead, used on the theme picker's buttons. */
function ThemeGlyph({ theme, accent, tint }: { theme: string; accent: string; tint: string }) {
  return (
    <span
      aria-hidden
      className="relative flex h-11 w-9 shrink-0 flex-col gap-[3px] rounded border border-border bg-white p-[3px]"
      style={theme === "bordered" ? { boxShadow: `inset 0 0 0 1px ${accent}` } : undefined}
    >
      <span
        className="block h-[7px] rounded-[1px]"
        style={{
          backgroundColor: theme === "banded" ? accent : tint,
          margin: theme === "bordered" ? "2px 2px 0" : undefined,
        }}
      />
      <span
        className="block h-[2px] self-center rounded-full"
        style={{ backgroundColor: accent, width: theme === "minimal" ? "40%" : "80%" }}
      />
      <span className="block h-[3px] w-full rounded-[1px]" style={{ backgroundColor: tint }} />
      <span className="block h-[2px] w-4/5 rounded-[1px] bg-border-strong" />
      <span className="block h-[2px] w-4/5 rounded-[1px] bg-border-strong" />
    </span>
  );
}

function Preview({
  institute,
  style,
}: {
  institute: Institute | null;
  style: ReturnType<typeof resolvePrintStyle>;
}) {
  const { palette, theme } = style;
  const name = institute?.name || "Your Institute Name";
  const address =
    [institute?.addressLine1, institute?.city, institute?.state, institute?.pincode].filter(Boolean).join(", ") ||
    "123 Education Road, Ahmedabad, Gujarat, 380001";
  const logo = institute?.logoStoragePath
    ? `/api/institute/logo?v=${institute.logoUpdatedAt?.getTime() ?? 0}`
    : null;

  return (
    <div
      className="rounded-md bg-white p-4 text-[10px] leading-tight shadow-inner"
      style={{
        color: palette.ink,
        boxShadow: theme.pageFrame ? `inset 0 0 0 1px ${palette.accent}` : undefined,
      }}
    >
      {/* Logo beside the text block, not above it — matching drawHeader, which
          keeps the letterhead short enough for two receipt copies to a sheet. */}
      <div className="flex items-start gap-2">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated route
          <img src={logo} alt="" className="h-9 w-9 shrink-0 object-contain" />
        ) : null}
        <div className="min-w-0 flex-1">
          {theme.nameBand ? (
            <div
              className="rounded-[2px] px-2 py-1 text-center text-[12px] font-bold"
              style={{ backgroundColor: palette.accent, color: palette.onAccent }}
            >
              {name}
            </div>
          ) : (
            <div className="text-center text-[12px] font-bold" style={{ color: palette.accent }}>
              {name}
            </div>
          )}

          <div className="mt-0.5 text-center" style={{ color: palette.muted }}>
            {address}
          </div>
          <div className="text-center text-[9px]" style={{ color: palette.muted }}>
            Phone: +91 79 1234 5678 · Email: office@example.edu.in
          </div>

          <div className="mt-2 text-center text-[11px] font-bold" style={{ color: palette.accent }}>
            FEE RECEIPT
          </div>
        </div>
      </div>

      <HeaderRule theme={theme.headerRule} accent={palette.accent} />

      <div className="mt-2 grid grid-cols-3 gap-2">
        {[
          ["RECEIPT NO.", "RCP00042"],
          ["DATE", "02 Aug 2026"],
          ["MODE", "UPI"],
        ].map(([label, value]) => (
          <div key={label}>
            <div className="text-[7px] font-medium" style={{ color: palette.muted }}>
              {label}
            </div>
            <div className="text-[9px]">{value}</div>
          </div>
        ))}
      </div>

      <div
        className="mt-2 text-[9px] font-bold"
        style={{ color: palette.accent, letterSpacing: `${theme.headingTracking}px` }}
      >
        Particulars
      </div>

      <table className="mt-1 w-full border-collapse text-[9px]">
        <thead>
          <tr
            style={{
              backgroundColor:
                theme.tableHeader === "solid"
                  ? palette.accent
                  : theme.tableHeader === "tint"
                    ? palette.tint
                    : "transparent",
              color: theme.tableHeader === "solid" ? palette.onAccent : palette.accent,
            }}
          >
            <th className="px-1 py-0.5 text-left font-bold">Particulars</th>
            <th className="px-1 py-0.5 text-right font-bold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["Installment 1 — semester 1", "₹25,000.00"],
            ["Late fee", "₹250.00"],
            ["Total received", "₹25,250.00"],
          ].map(([particular, amount], index) => (
            <tr key={particular} style={{ borderTop: `1px solid ${index === 0 ? palette.accent : palette.rule}` }}>
              <td className="px-1 py-0.5">{particular}</td>
              <td className="px-1 py-0.5 text-right tabular-nums">{amount}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 text-center text-[7px]" style={{ color: palette.muted }}>
        This is a computer-generated document.
      </div>
    </div>
  );
}

function HeaderRule({ theme, accent }: { theme: string; accent: string }) {
  if (theme === "short") {
    return <div className="mx-auto mt-1.5 h-[1px] w-1/4" style={{ backgroundColor: accent }} />;
  }
  if (theme === "double") {
    return (
      <div className="mt-1.5 space-y-[2px]">
        <div className="h-[1px] w-full" style={{ backgroundColor: accent }} />
        <div className="h-[0.5px] w-full" style={{ backgroundColor: accent }} />
      </div>
    );
  }
  return (
    <div
      className="mt-1.5 w-full"
      style={{ backgroundColor: accent, height: theme === "thick" ? 2 : 1 }}
    />
  );
}
