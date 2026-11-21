# Manthan ERP — monthly backup

A full copy of the ERP database, pulled onto the office PC once a month and
checked to be complete.

The ERP's database lives with a hosting provider who keeps their own backups.
Those protect them. This protects **you** — from a dropped table, a bad import,
a billing lapse, a closed account, or simply losing access on the day you need
the data. A copy that sits in the same account as the live data is not an
independent backup, so this one does not.

```
  ERP Manthan (cloud)                        Office PC running TallyPrime
 ┌──────────────────────────┐               ┌──────────────────────────────┐
 │ POST /api/jobs/backup    │  1. "give me  │  backup-agent (this folder)  │
 │        │                 │     everything"│       │                     │
 │        ▼                 │ ◄───────────── │       │  weekly, takes one   │
 │  every table, one        │  2. archive    │       │  backup per month    │
 │  consistent snapshot     │ ─────────────► │       ▼                      │
 │                          │                │  verify, then keep          │
 │ POST .../backup/file     │  3. documents  │  archives\manthan-backup-   │
 │  (only with --with-files)│ ─────────────► │    2026-11-01.ndjson.gz     │
 └──────────────────────────┘               └──────────────────────────────┘
```

Like the Tally bridge, the office PC **asks** the ERP for the data. No port is
opened on your office network, and the ERP holds no credentials for your PC.

## What is in a backup

| | |
|---|---|
| `manthan-backup-YYYY-MM-DD.ndjson.gz` | Every row of every table, in one consistent snapshot |
| `...ndjson.gz.sha256` | Checksum, so you can tell later if the file has rotted |
| `...manifest.json` | Readable summary: when it was taken, row counts, and every document it expects |
| `files\` | The documents and photographs themselves — only when run with `--with-files` |

**Student documents and photographs are inventoried but not copied by default.**
The database archive is small and quick; the documents can run to gigabytes.
The manifest records every one of them, so after a restore you can tell exactly
which files should exist. To copy the files too, set `WITH_FILES=true` in
`backup.env` once you have checked there is room.

## One-time setup

On the office PC — the same one that runs the Tally bridge is ideal, since it is
already switched on during office hours.

1. Install **Node.js 18 or later** from nodejs.org (LTS). Already done if the
   Tally bridge is running.
2. Copy this `backup-agent` folder to the PC, e.g. `C:\ManthanBackup`.
3. Copy `backup.env.example` to `backup.env`. Set `ERP_URL`, and set
   `ERP_JOB_SECRET` to the same value as `JOB_SECRET` in the ERP's environment
   variables.
4. Point `BACKUP_DIR` at somewhere that is **itself** backed up — an external
   drive, or a OneDrive / Google Drive folder. One copy on one PC is one fire
   away from no copies.
5. Run **install-task.cmd** once. It registers the schedule and takes the first
   backup immediately.

That is it. Check `backup.log` afterwards; the last line should say `Done.`

### Why the schedule is weekly

The task runs every Monday at 02:00, but the agent is given `--if-due`, so it
does nothing if the current month already has a verified backup. A monthly
trigger would simply be skipped if the PC happened to be off that night —
and an office PC is off most nights. This way the month's backup is taken on
the first Monday the PC is actually on.

## Day to day

Nothing. Check the folder every month or two and confirm there is a new file.

| | |
|---|---|
| `run-backup.cmd` | Take a backup now, whether or not this month has one |
| `verify-backups.cmd` | Re-read every archive on disk and confirm it is complete and unchanged |

## When a backup is refused

The agent downloads to a `.part` file and only puts it in place once it has read
the whole thing back and checked it. An archive ends with a trailer that the ERP
writes only after every table has been read, carrying the row count for each
one. If anything does not add up — a timeout mid-dump, a dropped connection, a
full disk — you get an error, a non-zero exit code, and **no new file in the
folder**.

This is deliberate. A backup that is quietly half a backup is worse than no
backup, because you will trust it.

If a run fails: read `backup.log`, fix what it names, and run
`run-backup.cmd`. Last month's archives are untouched.

## Restoring

From a machine with the repository checked out:

```
npm run backup:restore -- path\to\manthan-backup-2026-11-01.ndjson.gz --into "postgresql://..."
```

It validates the whole archive **before** touching the target, so a bad archive
cannot leave you with a half-emptied database. Then, in one transaction, it
erases the target, reinserts every row with its original id, and puts the
identity sequences back above what it inserted.

| Flag | |
|---|---|
| `--dry-run` | Check the archive and report what it holds. Writes nothing |
| `--force` | Required if the target already holds rows — it will be erased |
| `--into <url>` | Target database. Defaults to `DATABASE_URL`, which is probably not what you want |
| `--ignore-migration` | Proceed when the target's schema version differs from the archive's |
| `--allow-production` | Permit a restore while `NODE_ENV=production` |

Bring the target to the same migration first with `npm run db:deploy`; the
restore refuses a schema mismatch rather than guessing.

Documents are not in the archive. Restore them by copying `archives\files` back
into the blob store or `UPLOAD_DIR`. Until then the records are all present and
correct, and document downloads fail — which is why the manifest lists exactly
which files are expected.

### Practise the restore

**Do this once, now, before you need it.** A backup nobody has restored is a
guess. Restoring into a scratch database costs ten minutes and is the only way
to know the whole chain works:

```
npm run backup:restore -- archives\manthan-backup-2026-11-01.ndjson.gz --into "postgresql://postgres:PASSWORD@localhost:5432/restore_test" --dry-run
```

Then create `restore_test`, run `npm run db:deploy` against it, and repeat
without `--dry-run`.

## Security

`ERP_JOB_SECRET` can download every row in the database. Treat it exactly like
the database password:

- it lives only in `backup.env`, which is never committed;
- rotate `JOB_SECRET` in the ERP if this PC is replaced, sold or repaired;
- the archives are a full copy of student and financial records. Keep them
  where you would keep the paper files.

The file endpoint will only return a path that some row in the database
actually references, so it cannot be used to read anything else off the server.
Staff document access is unaffected and still goes through
`/api/documents/[id]`, which checks permissions per student.

## What this does not cover

- **Point-in-time recovery.** This is monthly. Up to a month of work can be lost
  on a restore. Your database provider's own backups are the finer-grained
  option, and they are complementary to this, not replaced by it.
- **Noticing silently.** If the PC stops running the task, nothing in the ERP
  will tell you. Looking at the folder occasionally is the current answer.
- **The documents, unless you turn them on.** `WITH_FILES=false` by default.
