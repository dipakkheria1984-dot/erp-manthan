/**
 * Appearance of printed material (spec 9.1).
 *
 * The admin picks two things in Institute setup and they apply to every PDF the
 * system generates — fee receipts, admission forms, the welcome kit and report
 * exports:
 *
 *   - a **colour scheme**, which is a single accent colour the rest of the
 *     palette is derived from, so no admin ever has to pick seven colours that
 *     work together;
 *   - a **theme**, which is the layout treatment of the letterhead, section
 *     headings, rules and table headers.
 *
 * Deliberately free of `server-only` and of any Prisma import: the setup screen
 * renders the same palettes as live swatches in the browser, from this file, so
 * the preview cannot drift from what the printer produces.
 */

/* -------------------------------------------------------------------------- */
/* Colour maths                                                                */
/* -------------------------------------------------------------------------- */

/** `#abc`, `abc123`, `#ABC123` → `#abc123`. Null when it is not a hex colour. */
export function normalizeHex(value: string): string | null {
  const raw = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(raw)) return null;
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
  return `#${full.toLowerCase()}`;
}

function channels(hex: string): [number, number, number] {
  const normalized = normalizeHex(hex) ?? "#000000";
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

/** `ratio` is how much of `b` ends up in the result: 0 → all `a`, 1 → all `b`. */
export function mixHex(a: string, b: string, ratio: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  const blend = (x: number, y: number) => Math.round(x + (y - x) * ratio);
  return `#${[blend(ar, br), blend(ag, bg), blend(ab, bb)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const channel = v / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Text colour that stays legible on a solid `background` fill. */
export function readableOn(background: string): string {
  return luminance(background) > 0.45 ? "#16181d" : "#ffffff";
}

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

export type PrintPalette = {
  /** Document titles, letterhead rules, band fills. */
  accent: string;
  /** Text drawn on top of a solid `accent` fill. */
  onAccent: string;
  /** Body text. Very slightly tinted towards the accent so pages read as one. */
  ink: string;
  /** Field labels, footers, page numbers, cut lines. */
  muted: string;
  /** Hairlines between table rows. */
  rule: string;
  /** Table header fills and other tinted panels. */
  tint: string;
  /** Cancelled/void stamps. Never themed — a void receipt must read as red. */
  alert: string;
};

/**
 * The whole palette from one accent, so every scheme is internally consistent
 * and "custom" is not a special case that has to be hand-tuned.
 */
export function paletteFromAccent(accent: string): PrintPalette {
  const normalized = normalizeHex(accent) ?? "#111318";
  return {
    accent: normalized,
    onAccent: readableOn(normalized),
    ink: mixHex("#111318", normalized, 0.12),
    muted: mixHex(normalized, "#8b8f98", 0.7),
    rule: mixHex(normalized, "#ffffff", 0.74),
    tint: mixHex(normalized, "#ffffff", 0.9),
    alert: "#b91c1c",
  };
}

/* -------------------------------------------------------------------------- */
/* Colour schemes                                                              */
/* -------------------------------------------------------------------------- */

export type PrintColorScheme = {
  id: string;
  label: string;
  description: string;
  /** Absent for "custom", whose accent comes from `Institute.printAccentHex`. */
  accent?: string;
};

export const PRINT_COLOR_SCHEMES: PrintColorScheme[] = [
  {
    id: "monochrome",
    label: "Monochrome",
    description: "Black and grey only. Reproduces cleanly on any office printer and photocopier.",
    accent: "#111318",
  },
  {
    id: "crimson",
    label: "Crimson",
    description: "The colour used across this application — matches on-screen and printed material.",
    accent: "#c1123c",
  },
  {
    id: "indigo",
    label: "Indigo",
    description: "A clear institutional blue, for documents that should not carry the house colour.",
    accent: "#1d4ed8",
  },
  {
    id: "navy",
    label: "Navy",
    description: "A deep, formal blue. Suits letterheads and official correspondence.",
    accent: "#14315c",
  },
  {
    id: "teal",
    label: "Teal",
    description: "Blue-green, legible at small sizes and distinct from the usual institutional blue.",
    accent: "#0f766e",
  },
  {
    id: "forest",
    label: "Forest",
    description: "A restrained green that keeps long fee tables easy on the eye.",
    accent: "#166534",
  },
  {
    id: "maroon",
    label: "Maroon",
    description: "Traditional academic red, common on Indian institute letterheads.",
    accent: "#7f1d1d",
  },
  {
    id: "amber",
    label: "Ochre",
    description: "A warm earth tone. Best paired with the Classic or Minimal theme.",
    accent: "#b45309",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Enter your institute's own accent colour as a hex code.",
  },
];

export const DEFAULT_COLOR_SCHEME_ID = "monochrome";

export function colorSchemeById(id: string): PrintColorScheme {
  return PRINT_COLOR_SCHEMES.find((scheme) => scheme.id === id) ?? PRINT_COLOR_SCHEMES[0];
}

/* -------------------------------------------------------------------------- */
/* Themes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A theme changes how things are *painted*, and is deliberately kept to within a
 * few points of every other theme's height: the fee receipt draws two copies
 * into fixed bands on one sheet, and switching theme must not push the second
 * copy off the page.
 */
export type PrintThemeId = "classic" | "banded" | "bordered" | "minimal";

export type PrintTheme = {
  id: PrintThemeId;
  label: string;
  description: string;
  /** Institute name reversed out of a solid accent band. */
  nameBand: boolean;
  /** Hairline frame around every page. */
  pageFrame: boolean;
  /** Table header row: filled solid, filled with a tint, or left plain. */
  tableHeader: "solid" | "tint" | "plain";
  /** Rule under the letterhead. */
  headerRule: "single" | "thick" | "double" | "short";
  /** Extra letter-spacing on section headings. */
  headingTracking: number;
};

export const PRINT_THEMES: PrintTheme[] = [
  {
    id: "classic",
    label: "Classic",
    description: "Centred letterhead over a single rule, plain table headers. The traditional office document.",
    nameBand: false,
    pageFrame: false,
    tableHeader: "tint",
    headerRule: "single",
    headingTracking: 0,
  },
  {
    id: "banded",
    label: "Banded",
    description: "Institute name reversed out of a solid colour band, with filled table headers. The boldest option.",
    nameBand: true,
    pageFrame: false,
    tableHeader: "solid",
    headerRule: "thick",
    headingTracking: 0,
  },
  {
    id: "bordered",
    label: "Bordered",
    description: "A hairline frame around every page and a double rule under the letterhead. Formal certificates and letters.",
    nameBand: false,
    pageFrame: true,
    tableHeader: "tint",
    headerRule: "double",
    headingTracking: 0.3,
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "A short centred rule, spaced-out headings and unfilled tables. Quietest on toner.",
    nameBand: false,
    pageFrame: false,
    tableHeader: "plain",
    headerRule: "short",
    headingTracking: 0.8,
  },
];

export const DEFAULT_THEME_ID: PrintThemeId = "classic";

export function themeById(id: string): PrintTheme {
  return PRINT_THEMES.find((theme) => theme.id === id) ?? PRINT_THEMES[0];
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

export type PrintStyle = {
  scheme: PrintColorScheme;
  theme: PrintTheme;
  palette: PrintPalette;
};

/** The subset of `Institute` the appearance is stored on. */
export type PrintStyleSource = {
  printColorScheme: string;
  printTheme: string;
  printAccentHex: string | null;
};

export function resolvePrintStyle(source: PrintStyleSource | null | undefined): PrintStyle {
  const scheme = colorSchemeById(source?.printColorScheme ?? DEFAULT_COLOR_SCHEME_ID);
  const theme = themeById(source?.printTheme ?? DEFAULT_THEME_ID);
  // A custom scheme whose colour was never filled in falls back to the default
  // rather than rendering every document in black-on-black.
  const accent =
    scheme.accent ??
    (source?.printAccentHex ? normalizeHex(source.printAccentHex) : null) ??
    colorSchemeById(DEFAULT_COLOR_SCHEME_ID).accent!;

  return { scheme, theme, palette: paletteFromAccent(accent) };
}

export const DEFAULT_PRINT_STYLE: PrintStyle = resolvePrintStyle(null);
