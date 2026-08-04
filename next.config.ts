import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Root inference walks up looking for a lockfile and can land above this
  // project when one happens to sit in a parent directory. Pin it, so a local
  // build resolves and traces exactly what the deployed build does.
  turbopack: { root: path.join(__dirname) },

  // pdfkit and exceljs load data files (font metrics, templates) from paths
  // relative to their own package directory. Bundling them rewrites those paths
  // and the lookups fail at runtime, so they stay external on the server.
  serverExternalPackages: ["pdfkit", "exceljs"],

  // src/lib/pdf.ts reads the embedded faces from `assets/fonts/` with a path
  // built at runtime, which output file tracing cannot follow. Without this the
  // files are left out of the deployed bundle and every PDF quietly degrades to
  // Helvetica — no ₹ and no Devanagari — instead of failing loudly.
  outputFileTracingIncludes: {
    "/*": ["./assets/fonts/**"],
    "/**": ["./assets/fonts/**"],
  },
};

export default nextConfig;
