import "server-only";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { Institute } from "@/generated/prisma/client";
import { formatDateTime } from "@/lib/dates";
import { DEFAULT_PRINT_STYLE, mixHex, type PrintPalette, type PrintStyle } from "@/lib/print-theme";

/**
 * Shared PDF building blocks for receipts, admission form printouts and report
 * exports. pdfkit is used server-side so nothing depends on a headless browser.
 *
 * ## Appearance
 *
 * Colours and layout treatment come from the print style the admin chose in
 * Institute setup (src/lib/print-theme.ts). Rather than thread a style argument
 * through a dozen helpers, `createDocument` records it against the document and
 * every helper reads it back with `styleOf`. Callers therefore only make the
 * choice once, where they create the document.
 *
 * Themes are near enough identical in height on purpose. The fee receipt lays
 * two copies into fixed bands on one sheet, so a theme that spent much vertical
 * space would push the office copy off the page. Only the banded letterhead
 * differs at all — by the band's padding — and the receipt absorbs it in the
 * terms block, which is ellipsed to fit rather than allowed to overrun.
 *
 * ## Fonts
 *
 * PDF's built-in fonts use WinAnsiEncoding, which has no ₹ (U+20B9) and no
 * non-Latin scripts. Two Unicode faces are embedded instead, vendored under
 * `assets/fonts/` so rendering never depends on the node_modules layout:
 *
 *   - **DejaVu Sans** (regular + bold) — the body face. Latin, Latin Extended,
 *     Cyrillic, Greek, and ₹.
 *   - **Noto Sans Devanagari** — used automatically for any run of text
 *     containing Devanagari, so Hindi/Marathi names render and shape correctly.
 *
 * pdfkit has no automatic font fallback, so `fontFor` picks the face per string
 * and every helper here routes its text through it. If a font file is missing
 * the document still renders, falling back to Helvetica.
 */

export const FONT = {
  body: "body",
  bold: "bold",
  devanagari: "devanagari",
} as const;

const FONT_FILES: Record<string, string> = {
  [FONT.body]: "DejaVuSans.ttf",
  [FONT.bold]: "DejaVuSans-Bold.ttf",
  [FONT.devanagari]: "NotoSansDevanagari.woff",
};

const FALLBACK: Record<string, string> = {
  [FONT.body]: "Helvetica",
  [FONT.bold]: "Helvetica-Bold",
  [FONT.devanagari]: "Helvetica",
};

let cachedFonts: Record<string, Buffer> | null = null;

function loadFonts(): Record<string, Buffer> {
  if (cachedFonts) return cachedFonts;

  const dir = path.join(process.cwd(), "assets", "fonts");
  const loaded: Record<string, Buffer> = {};
  for (const [name, file] of Object.entries(FONT_FILES)) {
    const full = path.join(dir, file);
    if (existsSync(full)) loaded[name] = readFileSync(full);
    else console.warn(`[pdf] font file missing: ${full} — falling back to a built-in face.`);
  }
  cachedFonts = loaded;
  return loaded;
}

/** Devanagari block, plus its extended and vedic ranges. */
const DEVANAGARI = /[ऀ-ॿ꣠-ꣿ᳐-᳿]/;

/**
 * The face to use for a given string: Devanagari text needs the Noto face,
 * everything else uses DejaVu. Bold is only available on the Latin face, so
 * Devanagari falls back to its regular weight rather than losing the script.
 */
export function fontFor(value: string, weight: "regular" | "bold" = "regular"): string {
  if (DEVANAGARI.test(value)) return FONT.devanagari;
  return weight === "bold" ? FONT.bold : FONT.body;
}

/** Sets the face appropriate for `value`, then writes nothing — callers draw. */
export function applyFontFor(doc: PdfDoc, value: string, weight: "regular" | "bold" = "regular"): PdfDoc {
  return doc.font(fontFor(value, weight));
}

export type PdfDoc = InstanceType<typeof PDFDocument>;

/**
 * The style each document was created with. A WeakMap rather than a property on
 * the document keeps pdfkit's own shape untouched and lets the entry go when the
 * document does.
 */
const documentStyles = new WeakMap<PdfDoc, PrintStyle>();

/** The institute logo to letterhead each page with, when one was uploaded. */
const documentLogos = new WeakMap<PdfDoc, Buffer>();

/** The style `doc` was created with, or the monochrome default. */
export function styleOf(doc: PdfDoc): PrintStyle {
  return documentStyles.get(doc) ?? DEFAULT_PRINT_STYLE;
}

/** Shorthand for the palette of `doc` — by far the most-read part of the style. */
export function paletteOf(doc: PdfDoc): PrintPalette {
  return styleOf(doc).palette;
}

/** Resets the fill colour to body ink. Every helper that tints text ends on this. */
function resetInk(doc: PdfDoc): PdfDoc {
  return doc.fillColor(paletteOf(doc).ink);
}

export function createDocument(options: {
  landscape?: boolean;
  title: string;
  /**
   * Keep every page in memory until the document ends, so `drawPageNumbers` can
   * go back and stamp "Page 1 of 5" once the total is known. Only worth it for
   * multi-page documents such as the welcome kit.
   */
  bufferPages?: boolean;
  /** Appearance chosen in Institute setup. Defaults to monochrome/classic. */
  style?: PrintStyle;
  /** Uploaded institute logo (PNG/JPEG bytes), drawn on every letterhead. */
  logo?: Buffer | null;
}): PdfDoc {
  const doc = new PDFDocument({
    size: "A4",
    layout: options.landscape ? "landscape" : "portrait",
    margin: 40,
    bufferPages: options.bufferPages ?? false,
    info: { Title: options.title },
    // Without this pdfkit initialises with Helvetica and reads its AFM metrics
    // before any font is registered.
    font: undefined as unknown as string,
  });

  const style = options.style ?? DEFAULT_PRINT_STYLE;
  documentStyles.set(doc, style);
  if (options.logo) documentLogos.set(doc, options.logo);

  const fonts = loadFonts();
  for (const name of Object.keys(FONT_FILES)) {
    if (fonts[name]) doc.registerFont(name, fonts[name]);
    else doc.registerFont(name, FALLBACK[name]);
  }
  doc.font(FONT.body).fillColor(style.palette.ink);

  if (style.theme.pageFrame) {
    // pdfkit emits `pageAdded` from the constructor's own first page, before any
    // listener can exist, so page one is framed by hand.
    doc.on("pageAdded", () => drawPageFrame(doc));
    drawPageFrame(doc);
  }
  return doc;
}

/** Hairline frame just outside the text area, drawn once per page. */
function drawPageFrame(doc: PdfDoc): void {
  const { palette } = styleOf(doc);
  const inset = 18;
  // Framing must not disturb the text cursor: it runs between content, and on
  // `pageAdded` before the caller has written anything to the new page.
  const { x, y } = doc;
  doc
    .save()
    .lineWidth(0.7)
    // Softened: a frame at full accent strength competes with the content it
    // is supposed to be containing.
    .strokeColor(mixHex(palette.accent, "#ffffff", 0.4))
    .rect(inset, inset, doc.page.width - inset * 2, doc.page.height - inset * 2)
    .stroke()
    .restore();
  doc.x = x;
  doc.y = y;
}

export function toBuffer(doc: PdfDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

/**
 * Draws the uploaded logo in a square box at the left of the letterhead and
 * returns the horizontal space it consumed, so the caller can inset its text by
 * that much. Returns 0 when there is no logo.
 *
 * The cursor is restored afterwards: the logo is positioned absolutely and must
 * not disturb the text flow that follows it.
 */
function drawLogo(doc: PdfDoc, box: number, left: number, top: number): number {
  const logo = documentLogos.get(doc);
  if (!logo) return 0;

  const { x, y } = doc;
  try {
    doc.image(logo, left, top, { fit: [box, box], align: "center", valign: "center" });
  } catch (error) {
    // A corrupt or unsupported image must never stop a receipt printing. Forget
    // it so the rest of the document — the second receipt copy, later pages —
    // is laid out consistently without it, and so this warns once.
    documentLogos.delete(doc);
    console.warn("[pdf] institute logo could not be embedded — printing without it.", error);
    return 0;
  } finally {
    doc.x = x;
    doc.y = y;
  }
  return box + 10;
}

/**
 * The institute name, reversed out of a solid accent band on themes that ask
 * for one. The band is painted behind the text at exactly the height the text
 * occupies, so the letterhead is the same height whichever theme is in force.
 */
function drawInstituteName(doc: PdfDoc, name: string, size: number, left: number, width: number): void {
  const { theme, palette } = styleOf(doc);
  applyFontFor(doc, name, "bold").fontSize(size);

  if (!theme.nameBand) {
    doc.fillColor(palette.accent).text(name, left, doc.y, { width, align: "center" });
    resetInk(doc);
    return;
  }

  const padding = size * 0.32;
  const height = doc.heightOfString(name, { width: width - padding * 2 }) + padding * 2;
  const top = doc.y;
  doc.save().rect(left, top, width, height).fill(palette.accent).restore();
  doc
    .fillColor(palette.onAccent)
    .text(name, left + padding, top + padding, { width: width - padding * 2, align: "center" });
  // Text drawn inside the band leaves the cursor mid-band; move it clear.
  doc.y = top + height;
  resetInk(doc);
}

/** Rule closing the letterhead, in the weight and width the theme calls for. */
function drawHeaderRule(doc: PdfDoc, left: number, right: number): void {
  const { theme, palette } = styleOf(doc);
  const y = doc.y;

  doc.save().strokeColor(palette.accent);
  switch (theme.headerRule) {
    case "thick":
      doc.lineWidth(2).moveTo(left, y).lineTo(right, y).stroke();
      break;
    case "double":
      doc.lineWidth(1).moveTo(left, y).lineTo(right, y).stroke();
      doc.lineWidth(0.4).moveTo(left, y + 2.5).lineTo(right, y + 2.5).stroke();
      break;
    case "short": {
      const width = Math.min(90, (right - left) / 4);
      const centre = (left + right) / 2;
      doc.lineWidth(0.9).moveTo(centre - width / 2, y).lineTo(centre + width / 2, y).stroke();
      break;
    }
    default:
      doc.lineWidth(1).moveTo(left, y).lineTo(right, y).stroke();
  }
  doc.restore();
}

/** Institute letterhead used at the top of every generated document. */
export function drawHeader(
  doc: PdfDoc,
  institute: Institute,
  title: string,
  subtitle?: string,
): void {
  const { palette } = styleOf(doc);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;

  // The logo sits outside the text block rather than above it: stacking it
  // would make the letterhead taller, which the fee receipt has no room for.
  const textLeft = left + drawLogo(doc, 52, left, doc.y);
  const textWidth = right - textLeft;

  drawInstituteName(doc, institute.name, 16, textLeft, textWidth);

  const addressParts = [
    institute.addressLine1,
    institute.addressLine2,
    institute.city,
    institute.state,
    institute.pincode,
  ].filter(Boolean);
  if (addressParts.length) {
    const address = addressParts.join(", ");
    applyFontFor(doc, address).fontSize(9).fillColor(palette.muted).text(address, textLeft, doc.y, {
      width: textWidth,
      align: "center",
    });
  }

  const contact = [
    institute.contactPhone ? `Phone: ${institute.contactPhone}` : null,
    institute.contactEmail ? `Email: ${institute.contactEmail}` : null,
  ].filter(Boolean);
  if (contact.length) {
    const line = contact.join("  ·  ");
    applyFontFor(doc, line).fontSize(8).fillColor(palette.muted).text(line, textLeft, doc.y, {
      width: textWidth,
      align: "center",
    });
  }

  doc.moveDown(0.7);
  applyFontFor(doc, title, "bold").fontSize(12).fillColor(palette.accent).text(title, textLeft, doc.y, {
    width: textWidth,
    align: "center",
  });
  if (subtitle) {
    applyFontFor(doc, subtitle).fontSize(9).fillColor(palette.muted).text(subtitle, textLeft, doc.y, {
      width: textWidth,
      align: "center",
    });
  }
  resetInk(doc);
  doc.moveDown(0.5);
  drawHeaderRule(doc, left, right);
  doc.moveDown(0.8);
  doc.x = left;
}

/**
 * Condensed letterhead for documents printed more than once to a page — the fee
 * receipt's student and office copies. `copyLabel` is boxed on the right so the
 * two halves are told apart at a glance.
 */
export function drawCompactHeader(
  doc: PdfDoc,
  institute: Institute,
  title: string,
  options: { subtitle?: string; copyLabel?: string } = {},
): void {
  const { theme, palette } = styleOf(doc);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.y;

  const textLeft = left + drawLogo(doc, 30, left, top);
  const textWidth = right - textLeft;

  drawInstituteName(doc, institute.name, 11, textLeft, textWidth);
  const afterName = doc.y;

  // Drawn after the name so a banded theme's fill cannot paint over it. On that
  // theme the box lands inside the band and is reversed out of it to stay legible.
  if (options.copyLabel) {
    const onBand = theme.nameBand;
    const ink = onBand ? palette.onAccent : palette.accent;
    const label = options.copyLabel.toUpperCase();
    doc.font(FONT.bold).fontSize(7);
    const width = doc.widthOfString(label) + 12;
    doc
      .save()
      .roundedRect(right - width - (onBand ? 4 : 0), top + (onBand ? 3 : 0), width, 14, 2)
      .lineWidth(0.7)
      .strokeColor(ink)
      .stroke()
      .restore();
    doc.fillColor(ink).text(label, right - width - (onBand ? 4 : 0), top + (onBand ? 7 : 4), {
      width,
      align: "center",
    });
    resetInk(doc);
    doc.y = afterName;
  }

  const addressParts = [institute.addressLine1, institute.city, institute.state, institute.pincode].filter(Boolean);
  if (addressParts.length) {
    const address = addressParts.join(", ");
    applyFontFor(doc, address).fontSize(7).fillColor(palette.muted).text(address, textLeft, doc.y, {
      width: textWidth,
      align: "center",
    });
  }

  const contact = [
    institute.contactPhone ? `Phone: ${institute.contactPhone}` : null,
    institute.contactEmail ? `Email: ${institute.contactEmail}` : null,
  ].filter(Boolean);
  if (contact.length) {
    const line = contact.join("  ·  ");
    applyFontFor(doc, line).fontSize(6.5).fillColor(palette.muted).text(line, textLeft, doc.y, {
      width: textWidth,
      align: "center",
    });
  }

  doc.moveDown(0.4);
  applyFontFor(doc, title, "bold").fontSize(10).fillColor(palette.accent).text(title, textLeft, doc.y, {
    width: textWidth,
    align: "center",
  });
  if (options.subtitle) {
    applyFontFor(doc, options.subtitle).fontSize(7.5).fillColor(palette.muted).text(options.subtitle, textLeft, doc.y, {
      width: textWidth,
      align: "center",
    });
  }
  resetInk(doc);

  doc.moveDown(0.3);
  drawHeaderRule(doc, left, right);
  doc.moveDown(0.4);
  doc.x = left;
}

/** Dashed rule showing where a page holding two copies should be cut. */
export function drawCutLine(doc: PdfDoc, y: number, label = "— — — please cut here — — —"): void {
  const { palette } = styleOf(doc);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;

  doc
    .save()
    .dash(3, { space: 3 })
    .moveTo(left, y)
    .lineTo(right, y)
    .strokeColor(palette.muted)
    .stroke()
    .restore();

  applyFontFor(doc, label).fontSize(6).fillColor(palette.muted).text(label, left, y + 3, {
    width: right - left,
    align: "center",
  });
  resetInk(doc);
  doc.x = left;
}

/** Bold section heading, script-aware. */
export function sectionHeading(doc: PdfDoc, label: string, size = 9): void {
  const { theme, palette } = styleOf(doc);
  applyFontFor(doc, label, "bold")
    .fontSize(size)
    .fillColor(palette.accent)
    .text(label, { characterSpacing: theme.headingTracking });
  resetInk(doc);
}

/** Breaks to a new page when `needed` points of vertical space are not left. */
export function ensureSpace(doc: PdfDoc, needed: number): void {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

/** Body paragraph, script-aware, followed by a blank line. */
export function drawParagraph(
  doc: PdfDoc,
  text: string,
  options: { size?: number; bold?: boolean; align?: "left" | "center" | "right" | "justify"; gap?: number } = {},
): void {
  const { palette } = styleOf(doc);
  applyFontFor(doc, text, options.bold ? "bold" : "regular")
    .fontSize(options.size ?? 9.5)
    .fillColor(palette.ink)
    .text(text, { align: options.align ?? "left", lineGap: 1.5 });
  doc.moveDown(options.gap ?? 0.6);
}

/** The two signature lines printed at the foot of forms and undertakings. */
export function drawSignatureRow(doc: PdfDoc, left: string, right: string): void {
  const { palette } = styleOf(doc);
  ensureSpace(doc, 70);
  doc.moveDown(1.5);
  const rightX = doc.page.width / 2 + 40;
  const top = doc.y;

  doc.font(FONT.body).fontSize(8).fillColor(palette.muted);
  doc.text("_______________________", doc.page.margins.left, top);
  applyFontFor(doc, left).fontSize(8).fillColor(palette.ink).text(left, doc.page.margins.left, doc.y);
  const afterLeft = doc.y;

  doc.font(FONT.body).fontSize(8).fillColor(palette.muted);
  doc.text("_______________________", rightX, top);
  applyFontFor(doc, right).fontSize(8).fillColor(palette.ink).text(right, rightX, doc.y);
  doc.y = Math.max(afterLeft, doc.y);
  doc.x = doc.page.margins.left;
}

/**
 * Stamps "Page 1 of 5" on every page. Requires `bufferPages: true` and must run
 * before `toBuffer`, which ends — and therefore flushes — the document.
 */
export function drawPageNumbers(doc: PdfDoc, prefix?: string): void {
  const { palette } = styleOf(doc);
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    const label = `${prefix ? `${prefix}  ·  ` : ""}Page ${i + 1} of ${range.count}`;
    // Text drawn inside the bottom margin would otherwise spill onto a fresh
    // page, which would in turn invalidate the count being stamped.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    applyFontFor(doc, label)
      .fontSize(7)
      .fillColor(palette.muted)
      .text(label, doc.page.margins.left, doc.page.height - 28, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: "center",
      });
    doc.page.margins.bottom = bottom;
  }
  resetInk(doc);
}

/**
 * Label/value grid. `compact` shrinks it for documents printed more than once to
 * a page — the two fee receipt copies.
 */
export function drawFieldRows(
  doc: PdfDoc,
  rows: [string, string][],
  options: { columns?: number; compact?: boolean } = {},
): void {
  const { palette } = styleOf(doc);
  const columns = options.columns ?? 2;
  const labelSize = options.compact ? 6 : 7.5;
  const valueSize = options.compact ? 8 : 10;
  const rowGap = options.compact ? 4 : 8;
  const trailingHeight = options.compact ? 22 : 34;

  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usable / columns;
  let column = 0;
  let rowTop = doc.y;

  for (const [label, value] of rows) {
    const x = doc.page.margins.left + column * colWidth;
    const shown = value || "—";
    applyFontFor(doc, label).fontSize(labelSize).fillColor(palette.muted).text(label.toUpperCase(), x, rowTop, {
      width: colWidth - 12,
    });
    applyFontFor(doc, shown).fontSize(valueSize).fillColor(palette.ink).text(shown, x, doc.y, {
      width: colWidth - 12,
    });

    column += 1;
    if (column >= columns) {
      column = 0;
      rowTop = doc.y + rowGap;
      doc.y = rowTop;
    } else {
      doc.y = rowTop;
    }
  }

  if (column !== 0) doc.y = rowTop + trailingHeight;
  resetInk(doc);
  // Every cell was drawn at an explicit x, which leaves the cursor in the last
  // column. Anything written next would then wrap inside that column's width.
  doc.x = doc.page.margins.left;
  doc.moveDown(0.5);
}

export type TableColumn = { header: string; width: number; align?: "left" | "right" };

export function drawTable(doc: PdfDoc, columns: TableColumn[], rows: string[][]): void {
  const { theme, palette } = styleOf(doc);
  const startX = doc.page.margins.left;
  const bottom = doc.page.height - doc.page.margins.bottom - 40;
  const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);

  /** The header's fill and text, per theme. `null` fill leaves the paper bare. */
  const headerFill =
    theme.tableHeader === "solid" ? palette.accent : theme.tableHeader === "tint" ? palette.tint : null;
  const headerText = theme.tableHeader === "solid" ? palette.onAccent : palette.accent;

  const drawRow = (cells: string[], header: boolean) => {
    if (doc.y > bottom) {
      doc.addPage();
    }
    const top = doc.y;
    doc.fontSize(8.5);

    // Measured before anything is drawn: the header fill has to be painted
    // under the text, which means knowing the row height up front.
    const heights = cells.map((cell, i) => {
      applyFontFor(doc, cell ?? "", header ? "bold" : "regular");
      return doc.heightOfString(cell ?? "", { width: columns[i].width - 8 });
    });
    const maxHeight = Math.max(0, ...heights);

    if (header && headerFill) {
      doc.save().rect(startX, top, totalWidth, maxHeight + 8).fill(headerFill).restore();
    }

    let x = startX;
    cells.forEach((cell, i) => {
      const column = columns[i];
      const value = cell ?? "";
      // Per cell, so one Devanagari name does not switch the whole row.
      applyFontFor(doc, value, header ? "bold" : "regular");
      doc
        .fillColor(header ? headerText : palette.ink)
        .text(value, x + 4, top + 4, { width: column.width - 8, align: column.align ?? "left" });
      x += column.width;
    });

    doc.y = top + maxHeight + 8;
    doc
      .save()
      // The rule below the header carries the theme's accent; body rows keep the
      // quiet hairline that lets the numbers dominate.
      .lineWidth(header ? 0.8 : 0.5)
      .strokeColor(header ? palette.accent : palette.rule)
      .moveTo(startX, doc.y - 2)
      .lineTo(startX + totalWidth, doc.y - 2)
      .stroke()
      .restore();
  };

  drawRow(columns.map((c) => c.header), true);
  for (const row of rows) drawRow(row, false);
  resetInk(doc);
  // Cells are drawn at an explicit x; without this the next paragraph would
  // wrap inside the width of the final column.
  doc.x = startX;
}

export type PrintableTerms = { version: number; title: string; content: string };

/**
 * Terms & conditions confined to `maxHeight`, for a document sharing a page with
 * another — the two fee receipt copies. Never breaks to a new page: anything
 * that will not fit is ellipsed, so the copy below is never overrun. Returns
 * false when there was no room to print anything at all.
 */
export function drawTermsBlock(
  doc: PdfDoc,
  terms: PrintableTerms | null,
  options: { maxHeight: number; size?: number },
): boolean {
  if (!terms) return false;
  const text = htmlToPlainText(terms.content);
  if (!text.trim()) return false;

  const { palette } = styleOf(doc);
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const headingSize = (options.size ?? 6) + 0.5;
  // Rule, heading and a little breathing room before any body text is worth it.
  if (options.maxHeight < headingSize + 12) return false;

  const top = doc.y;
  doc.save().lineWidth(0.5).strokeColor(palette.rule).moveTo(left, top).lineTo(left + width, top).stroke().restore();

  const heading = `${terms.title} (v${terms.version})`;
  applyFontFor(doc, heading, "bold")
    .fontSize(headingSize)
    .fillColor(palette.accent)
    .text(heading, left, top + 3, { width });

  const remaining = top + options.maxHeight - doc.y;
  if (remaining > 6) {
    applyFontFor(doc, text)
      .fontSize(options.size ?? 6)
      .fillColor(palette.muted)
      .text(text, left, doc.y, { width, align: "left", height: remaining, ellipsis: true });
  }

  resetInk(doc);
  doc.x = left;
  return true;
}

/** Terms & conditions block printed at the bottom of receipts and forms. */
export function drawTerms(doc: PdfDoc, terms: PrintableTerms | null): void {
  if (!terms) return;

  const text = htmlToPlainText(terms.content);
  if (!text.trim()) return;

  if (doc.y > doc.page.height - doc.page.margins.bottom - 140) {
    doc.addPage();
  }

  const { palette } = styleOf(doc);
  doc.moveDown(1);
  doc
    .save()
    .strokeColor(palette.accent)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke()
    .restore();
  doc.moveDown(0.5);
  const heading = `${terms.title} (v${terms.version})`;
  applyFontFor(doc, heading, "bold").fontSize(8).fillColor(palette.accent).text(heading);
  applyFontFor(doc, text).fontSize(7).fillColor(palette.muted).text(text, { align: "left" });
  resetInk(doc);
}

export function drawFooter(doc: PdfDoc, note?: string): void {
  const line = note ?? `Generated ${formatDateTime(new Date())} · This is a computer-generated document.`;
  doc.moveDown(1);
  applyFontFor(doc, line).fontSize(7).fillColor(paletteOf(doc).muted).text(line, { align: "center" });
  resetInk(doc);
}

/**
 * The T&C editor stores rich text; PDFs need plain text. Block-level tags become
 * line breaks and list items get a bullet, so numbered clauses stay readable.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    // `</li>` deliberately absent: the opening tag already broke the line, and
    // closing it too would double-space every clause.
    .replace(/<\s*\/\s*li\s*>/gi, "")
    .replace(/<\s*\/\s*(p|div|h[1-6]|ol|ul|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}
