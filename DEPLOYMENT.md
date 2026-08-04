# Deploying to Vercel

Target setup: **Vercel** runs the app, **Neon** hosts Postgres, **Vercel Blob**
holds uploaded documents. Everyone who needs the app gets a URL and signs in with
an account an Admin created for them — there is no public sign-up.

Work through this once, in order. Steps 3–6 need you signed in to Vercel and
Neon in a browser.

---

## 1. Push the repository

Already done if you followed the setup conversation. Otherwise:

```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## 2. Generate the secrets

Run this and keep the output — you will paste these into Vercel in step 5.

```bash
node -e "console.log('AUTH_SECRET=' + require('crypto').randomBytes(48).toString('base64url')); console.log('JOB_SECRET=' + require('crypto').randomBytes(24).toString('base64url')); console.log('CRON_SECRET=' + require('crypto').randomBytes(24).toString('base64url'))"
```

Also decide the first Admin's email and password now. The password must be a
real one — the seed refuses to run with the built-in default when
`NODE_ENV=production`.

## 3. Create the database

1. At [neon.tech](https://neon.tech), create a project. Pick a region near your
   users (`ap-south-1`, Mumbai, for an institute in India).
2. From the dashboard copy **both** connection strings:
   - **Pooled** — the host contains `-pooler`. This is `DATABASE_URL` for the app.
   - **Direct** — no `-pooler`. Migrations need this one.

   Serverless functions open a connection per invocation, so the app must go
   through the pooler or it will exhaust the connection limit. Prisma Migrate,
   conversely, cannot run through a transaction pooler.

## 4. Import the project into Vercel

1. At [vercel.com/new](https://vercel.com/new), import the GitHub repository.
2. Framework preset: **Next.js**. Leave the build and output settings alone.
3. **Do not deploy yet** — add the environment variables first (step 5), or the
   first build will fail on the missing `DATABASE_URL`.

## 5. Environment variables

In the project's **Settings → Environment Variables**, add these for
Production (and Preview, if you want previews to work):

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Neon **pooled** string |
| `DIRECT_URL` | Neon **direct** string. `prisma.config.ts` prefers this for migrations, so `npm run db:deploy` picks the right connection on its own. |
| `AUTH_SECRET` | from step 2 |
| `JOB_SECRET` | from step 2 |
| `CRON_SECRET` | from step 2 |
| `TZ` | `Asia/Kolkata` |

`BLOB_READ_WRITE_TOKEN` is added for you in the next step. Do **not** set
`UPLOAD_DIR` — leaving it out is what keeps uploads on the blob store.

## 6. Create the Blob store

In the project's **Storage** tab, create a **Blob** store and connect it to the
project. Vercel injects `BLOB_READ_WRITE_TOKEN` automatically.

That token's presence is the switch: with it, `src/lib/storage.ts` writes to the
blob store; without it, it writes to the local disk, and on a serverless host
those files vanish. If documents upload fine but 404 a day later, this is why.

## 7. Deploy, then migrate and seed

Trigger the first deploy (**Deployments → Redeploy**, or push a commit).

Then, from your machine, point the migration and seed at Neon. `prisma.config.ts`
reads `DIRECT_URL` in preference to `DATABASE_URL`, so set that one:

```bash
DIRECT_URL="<neon-direct-string>" npm run db:deploy
```

```bash
NODE_ENV=production DIRECT_URL="<neon-direct-string>" SEED_ADMIN_EMAIL="you@yourinstitute.org" SEED_ADMIN_PASSWORD="<a-real-password>" npm run db:seed
```

On Windows PowerShell the syntax differs — set each variable first, then run:

```bash
$env:DIRECT_URL="<neon-direct-string>"; npm run db:deploy
```

Migrations are deliberately **not** part of the build. A build that migrates
runs DDL against live student data every time it deploys, and leaves the
database ahead of the code if you ever roll a deployment back.

## 8. First sign-in

Open the deployment URL, sign in as the seeded Admin. The account is created
with `mustResetPassword`, so you will be forced to set a new password
immediately. Do it now, before sharing the URL.

Then, in the app:

- **Setup** — institute profile, logo, academic years, late-fee slabs, document
  requirements, terms.
- **Users** — create an account per staff member and assign a role. Roles are
  built from permissions, not the other way round; Admin can define new ones.

## 9. Check the scheduled reminder

`vercel.json` registers a daily cron on `/api/jobs/reminders` at `30 3 * * *`
**UTC**, which is 09:00 IST. Vercel cron expressions are always UTC — if you
change the time, convert it yourself.

Confirm it is registered under **Settings → Cron Jobs**. On the Hobby plan crons
run at most once a day and fire within roughly an hour of the stated time.

To test it without waiting:

```bash
curl -X POST -H "x-job-secret: $JOB_SECRET" https://<your-app>.vercel.app/api/jobs/reminders
```

Until real email/WhatsApp credentials are configured under **Setup →
Communication**, the providers run in log-only mode: the pass records what it
would have sent and nothing goes out.

---

## Notes for later

**Schema changes.** Migrations are deliberately not part of the build — a build
that migrates can leave the database ahead of a rolled-back deployment. After
changing the schema, run `npm run db:deploy` against the direct connection
string yourself, then deploy.

**Costs.** Neon, Vercel and Blob all have free tiers this app fits inside at
small scale. The two that grow with real use are blob storage (every uploaded
document) and Neon's compute hours.

**Backups.** Neon keeps point-in-time restore on paid plans; the free tier's
history window is short. Student records and the audit log live only in that
database — if this is running a real institute, take your own periodic dump.

**Uploads are not in the database.** A Neon restore brings back rows pointing at
blob paths. The blob store is a separate system with its own lifecycle; the two
can drift apart if you restore one without the other.
