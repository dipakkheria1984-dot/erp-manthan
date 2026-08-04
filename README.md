# Institute ERP

Enrollment, fees, academics, promotion and reporting for an educational institute.

**Stack:** Next.js 16 (App Router, server actions) · Prisma 7 + PostgreSQL · Tailwind 4 · pdfkit · ExcelJS · nodemailer.

---

## Getting started

```bash
npm install
cp .env.example .env       # then fill in DATABASE_URL and AUTH_SECRET
npm run db:migrate
npm run db:seed
npm run dev
```

Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env`. The seeded
admin is created with `mustResetPassword`, so the first sign-in forces a new
password.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:deploy` | Apply migrations (production) |
| `npm run db:seed` | Seed config, roles, admin, checklist, T&C |
| `npm run db:studio` | Prisma Studio |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run job:reminders` | Trigger one fee-reminder pass |

### Dev-only helpers (`scripts/`)

Not wired into `package.json` — run with `npx tsx`:

- `dev-create-staff.ts <RoleName> <email>` — staff account with a known password,
  for exercising role-based access
- `dev-fill-semester-fees.ts` — default exam/activity fees on semesters
- `dev-backdate-installments.ts <StudentCode>` — backdate an installment to
  exercise late-fee slabs and the overdue reminder path

---

## Conventions worth knowing

**Money is integer paise.** Every monetary column is suffixed `Paise` and holds
an integer number of paise (₹1 = 100). Parse at the edge with `rupeesToPaise`,
format with `formatPaise` (UI), `formatPaisePdf` (PDFs) or `formatPaisePlain`
(Excel/CSV, bare numbers so spreadsheets can total them). Nothing holds a rupee
float.

**PDF fonts are embedded.** PDF's built-in faces use WinAnsiEncoding, which has
no ₹ and no non-Latin scripts. `src/lib/pdf.ts` embeds **DejaVu Sans**
(regular + bold: Latin, Latin Extended, Cyrillic, Greek, ₹) and **Noto Sans
Devanagari**, vendored under `assets/fonts/` with their licences so rendering
never depends on the node_modules layout. pdfkit has no automatic fallback, so
`applyFontFor(doc, text)` picks the face per string — and per table *cell* — and
every drawing helper routes through it. A Hindi or Marathi name therefore shapes
correctly next to Latin text on the same row. Missing font files degrade to
Helvetica rather than failing the document.

To add another script, drop the font in `assets/fonts/`, register it in
`FONT_FILES`, and extend the detection in `fontFor`.

**Server actions return `ActionResult`.** Wrap bodies in `runAction` so domain
errors surface as friendly messages and unexpected ones are logged without
leaking internals. Forms use `ActionForm` from `src/components/form.tsx`.

**Permissions, not role names.** `src/lib/permissions.ts` is the catalogue;
Admin/Registrar/Accountant are seeded from it and Admin can build custom roles
out of the same permissions. Always check a permission, never a role name.

**Two permission guards.** Pages and layouts use `requirePermission`, which
*redirects* to `/denied` — throwing there would surface as a 500. Server actions
use `assertPermission`, which throws so `runAction` can return the failure to
the form. Don't mix them up.

**Audit everything sensitive.** `recordAudit` outside a transaction (never
throws), `recordAuditTx` inside one (rolls the unit of work back if the audit
write fails). Approvals, rejections, status changes, receipt cancellations and
waivers all carry a mandatory written reason.

---

## How the tricky business rules are implemented

### Tuition is rate-locked; exam and activity fees are not

`BatchFeeHistory` versions a batch's preset tuition by `effectiveFrom`. On
approval, `tuitionRateAt(batchId, enrollmentDate)` resolves the version in force
on the student's enrollment date and stores it as
`FeeAssignment.lockedTuitionRatePaise` — that rate follows the student for every
later year. Exam and activity fees live on `Semester` and always apply at their
current value.

### Scholarship threshold is hidden

`InstituteConfig.scholarshipAutoApprovePercent` is readable only through
`getConfig()` (server-side / Admin screens). `getPublicConfig()` strips it, so a
Registrar screen cannot leak it. Requesting a discount above the threshold shows
only the generic *"This discount requires Admin approval"* and routes the
application to **Under Review** on submission; the discount is recorded as
*requested*, never applied, until an Admin sets the final figure at approval.

### Late fees

`src/lib/late-fees.ts` applies, in order: nothing inside the grace period; no
fee at all when the remaining principal is at or below the Minimum Outstanding
Threshold; otherwise the matching slab's amount in full (flat, never prorated);
and accrual stops once principal and late fee are settled. Payments settle the
late fee before principal — `Payment.lateFeePortionPaise` records the split.

### Receipt cancellation

Admin-only, mandatory reason, no time limit. The row is marked `CANCELLED` and
never deleted; the receipt number is retained and never reused. The affected
installment's status and late fee are recalculated against the *original* due
date. Cancelled receipts are excluded entirely from the Fee Collection report
and its totals, but remain visible in the Student Ledger as audit entries.

### Status changes and reinstatement

Moving a student to Dropped-out or Expelled auto-waives every pending and
partly-paid installment along with accrued late fees. Money already received is
**not** auto-refunded. Reinstating does **not** restore the waivers — Admin
reviews them case by case on the student record and restores individually, at
which point the late fee is re-assessed against the original due date.

### Promotion

Bulk by default with a preview and per-student exclusions (reason recorded).
Pending dues never block a promotion; the balance stays tagged to its original
semester. A failing student is promoted with an informational backlog flag.
Tuition is re-applied **only** when the promotion crosses into a new year of the
course, charged at the locked rate with no scholarship carried forward.

### Bulk student import

`/students/import` (permission `student.import`) migrates existing student data
from CSV or XLSX. It runs in two passes against the same stored file: parse and
validate for the preview, then re-validate and commit, so what an Admin approves
is exactly what gets written and nothing is trusted through the browser.

Rows land directly as enrolled students — this is a migration path, not the
admission workflow — each with a backing Application marked as migrated so the
audit trail records how they entered. Hard failures (unknown department/course/
batch code, bad gender or status, non-existent semester, duplicate or taken LF
No, batch at capacity, due date past batch completion) skip the row; soft
signals (duplicate National ID, same name + DOB, no contact details) are
warnings and still import. Seat capacity counts rows already accepted from the
same file, not just what's in the database.

An optional `Outstanding Amount` + `Outstanding Due Date` carries the old
system's balance in as a single labelled opening-balance installment, so the
Student Ledger and Fee Due report are complete from day one. A literal `0` is
treated as "owes nothing" and needs no due date. Ongoing semester fees are not
imported — those come from the promotion run.

Templates: `/api/templates/student-import?format=xlsx` (includes a column-guide
sheet) or `?format=csv`.

### Notifications

Email and WhatsApp always go out **together** for every reminder — the pair
shares a `NotificationLog.groupKey`. Providers are pluggable adapters
(`src/lib/notification-providers.ts`); until real credentials are configured
they run in log-only mode so nothing else is blocked. Failed deliveries are
logged and surfaced on the Reminders screen.

Schedule the daily pass against:

```bash
curl -X POST -H "x-job-secret: $JOB_SECRET" https://your-host/api/jobs/reminders
```

The pass is idempotent: pre-due goes out once per installment, overdue only
after the configured interval has elapsed.

---

## Assumptions made where the spec was silent

- **Registration fee is treated as an advance.** Whatever is collected at the
  registration-fee step is deducted from the first year's payable before the
  installment plan is built, so it is never billed twice. Visible on the
  application overview and in the ledger. If it should instead be a separate
  non-adjustable charge, change the `netPayable` calculation in
  `approveApplicationAction`.
- **Tuition is charged at the first semester of each year**, not spread per
  semester — this follows from "Year 2 onward = Year 1's original fee" combined
  with "same-year semester promotion does not re-trigger tuition".
- **Semesters are auto-generated when a batch is created**, evenly spread across
  the batch window, with dates and per-semester fees editable afterwards.
- **Document uploads are stored on local disk** under `UPLOAD_DIR` and served
  through an authorising route (`/api/documents/[id]`) rather than from
  `/public`. Swap the three functions in `src/lib/storage.ts` for S3/GCS in
  production.

## Known gaps

- **Only Latin-family scripts and Devanagari are covered by the embedded PDF
  fonts.** Tamil, Telugu, Bengali, Gujarati and the rest need their own Noto
  face added as above — the mechanism is in place, the fonts are not.
- **Refund processing and backlog re-attempt tracking** are out of scope per the
  spec (§4.3, §6.3).

---

## Deployment

The app runs anywhere there is a Node server. It is set up here for **Vercel +
Neon Postgres + Vercel Blob**; see [DEPLOYMENT.md](DEPLOYMENT.md) for the
step-by-step.

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | On Vercel use Neon's **pooled** string (host contains `-pooler`). Migrations need the direct one. |
| `AUTH_SECRET` | yes | 32+ random chars. Rotating it signs everyone out. |
| `SESSION_TTL_HOURS` | no | Defaults to 12. |
| `BLOB_READ_WRITE_TOKEN` | on Vercel | Set automatically when a Blob store is connected. Its presence is what switches uploads off the local disk. |
| `UPLOAD_DIR` / `MAX_UPLOAD_MB` | no | Local-disk driver only; ignored once the blob token is set. |
| `JOB_SECRET` | yes | Guards `POST /api/jobs/*`. |
| `CRON_SECRET` | on Vercel | Guards the `GET` that Vercel Cron issues. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | at seed time | The seed refuses the built-in default under `NODE_ENV=production`. |
| `TZ` | no | `Asia/Kolkata`. Set automatically at start-up by `src/instrumentation.ts`; Vercel reserves the name, so it cannot be set there. |

Then `npm run db:deploy` (against the **direct** connection string) and
`npm run db:seed`.

### Things that will bite you

- **Uploads must not go to the local disk.** A serverless filesystem is
  ephemeral. `src/lib/storage.ts` therefore has two drivers and picks the blob
  store whenever `BLOB_READ_WRITE_TOKEN` is set. Blobs are written with
  `access: "private"`, so documents stay reachable only through
  `/api/documents/[id]`, which checks permissions first — a public bucket would
  route around that check.
- **The PDF fonts are read by a runtime-built path**, which output file tracing
  cannot follow. `outputFileTracingIncludes` in `next.config.ts` forces
  `assets/fonts/**` into the bundle. Without it every PDF silently falls back to
  Helvetica: no ₹, no Devanagari.
- **`pdfkit` and `exceljs` are in `serverExternalPackages`** — they load data
  files relative to their own package directory and break if bundled.
- **The reminder cron is a `GET`.** Vercel Cron cannot send a custom header, so
  it authenticates with `Authorization: Bearer $CRON_SECRET` rather than
  `x-job-secret`. `vercel.json` schedules it at `30 3 * * *` **UTC** — Vercel
  cron expressions are always UTC, and that is 09:00 IST.
- **The time zone is set in code, not the environment.** Date arithmetic follows
  the process zone, so a server on UTC puts due dates on the wrong side of
  midnight for five and a half hours a day. Vercel reserves the variable name
  `TZ` and rejects it, so `src/instrumentation.ts` assigns it at server
  start-up instead — Node re-reads the zone on assignment. An explicit `TZ` in
  the environment still wins on hosts that permit one, and
  `assertIstProcess()` warns if neither took effect.
- **Session cookies are `secure` in production**, so serve over HTTPS.
