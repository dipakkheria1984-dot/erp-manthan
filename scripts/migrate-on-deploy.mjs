/**
 * Apply pending migrations ahead of the build — but only for Production.
 *
 * The build migrates so that a deploy can never go live against a database
 * that lacks the columns its code reads (see commit 013b74a). On Vercel,
 * though, Preview deployments share the production DATABASE_URL, so the same
 * step let every pull request change live student data before anyone had
 * reviewed it — and a migration that was then abandoned or reworked stayed
 * applied.
 *
 * So: Production builds migrate, and so does a build outside Vercel (a local
 * `npm run build`, as before). Preview and Development builds on Vercel skip
 * the step and say so in the build log.
 */

import { spawnSync } from "node:child_process";

const target = process.env.VERCEL_ENV;

if (target && target !== "production") {
  console.log(
    `[build] VERCEL_ENV=${target}: skipping \`prisma migrate deploy\`. ` +
      "Preview builds share the production database and must not change it.",
  );
  process.exit(0);
}

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  // npx is npx.cmd on Windows, which only resolves through a shell.
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
