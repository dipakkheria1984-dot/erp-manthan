import "server-only";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { ValidationError } from "@/lib/errors";

/**
 * Turns the first page of a PDF into a PNG.
 *
 * Banks hand out payment QRs as PDFs. A browser cannot put one in an `<img>`,
 * and an `<object>` or `<iframe>` is miserable on the phone most applicants are
 * holding — so the page is rasterised once at upload and everything downstream
 * deals with an ordinary image.
 *
 * Rendered at a fixed target size rather than the PDF's own: a QR is read by a
 * camera, and what matters is that the modules end up large and square, not
 * that the page is reproduced faithfully.
 */
const TARGET_PX = 1400;

/** Anything at or above this on all channels counts as page white. */
const WHITE = 250;

/** Breathing room left around the trimmed content, in pixels. */
const MARGIN = 24;

export async function pdfFirstPageToPng(bytes: Buffer): Promise<Buffer> {
  // The legacy build is the one that runs under Node without a DOM.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
    }).promise;
  } catch {
    throw new ValidationError("That PDF could not be read. Try exporting it again, or upload a PNG or JPG.");
  }

  if (doc.numPages < 1) throw new ValidationError("That PDF has no pages.");

  const page = await doc.getPage(1);
  const unscaled = page.getViewport({ scale: 1 });
  // Capped so a poster-sized sheet cannot balloon the render.
  const scale = Math.min(TARGET_PX / unscaled.width, TARGET_PX / unscaled.height, 4);
  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  // PDF pages are transparent where nothing is drawn; a QR needs white behind
  // it or the dark modules land on black in a dark-mode viewer.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  // pdf.js is typed against the browser's canvas; this is the native one, which
  // implements the drawing surface it actually uses but not the DOM element
  // around it. The cast is confined to this call.
  await page.render({
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
    canvas: canvas as unknown as HTMLCanvasElement,
  }).promise;

  return trimToContent(canvas);
}

/**
 * Crops the page's white margins away.
 *
 * A bank's QR usually sits in the middle of an otherwise empty A4, and shown
 * whole in the small box on the payment step the code would be too small for a
 * camera to resolve. Trimming to the ink makes it as large as the space allows.
 */
function trimToContent(canvas: Canvas): Buffer {
  const context = canvas.getContext("2d");
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);

  let top = height;
  let left = width;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i] >= WHITE && data[i + 1] >= WHITE && data[i + 2] >= WHITE) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }

  // A blank page: nothing to crop to, so hand back what was rendered rather
  // than an empty image.
  if (right < 0 || bottom < 0) return canvas.toBuffer("image/png");

  const x = Math.max(0, left - MARGIN);
  const y = Math.max(0, top - MARGIN);
  const w = Math.min(width - x, right - left + 1 + MARGIN * 2);
  const h = Math.min(height - y, bottom - top + 1 + MARGIN * 2);

  const out = createCanvas(w, h);
  const outContext = out.getContext("2d");
  outContext.fillStyle = "#ffffff";
  outContext.fillRect(0, 0, w, h);
  outContext.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out.toBuffer("image/png");
}
