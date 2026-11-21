# Manthan ERP → Tally Prime (Edit Log) connector

Every receipt taken by **UPI, card, bank transfer, cheque or other** is posted to
TallyPrime as a Receipt voucher automatically. When a receipt is cancelled in the
ERP, its voucher is **cancelled** in Tally. It is never deleted, so TallyPrime Edit
Log keeps the creation and the cancellation side by side for your auditor.

**Cash receipts are not sent.** They reach Tally from the cash book as before.

## How it works

```
  ERP Manthan (cloud)                          Office PC running TallyPrime
 ┌─────────────────────────┐                  ┌──────────────────────────────┐
 │ Receipt saved (non-cash)│                  │  tally-bridge (this folder)  │
 │        │                │   1. "any work?" │        │                     │
 │        ▼                │ ◄─────────────── │        │  every 20 s         │
 │  TallySyncOutbox queue  │   2. voucher XML │        ▼                     │
 │                         │ ───────────────► │  POST localhost:9000 ──► Tally│
 │  Setup › Tally Prime    │   3. Tally reply │        │     Edit Log records│
 │  (status, retry)        │ ◄─────────────── │        ▼     the voucher     │
 └─────────────────────────┘                  └──────────────────────────────┘
```

Tally only listens on the office PC, and the ERP runs in the cloud. The bridge
therefore **asks** the ERP for work. No port is opened on your office network.

If the PC is off or Tally is closed, receipts wait in the queue. They are posted
as soon as Tally is back. Nothing is lost.

## One-time setup

### 1. In TallyPrime (Edit Log)

1. Open the company you post fees into.
2. Turn on the XML port: **F1 (Help) › Settings › Connectivity › Client/Server
   configuration**. Set *TallyPrime acts as* to **Both** and *Port* to **9000**.
   Restart Tally.
3. Make sure these ledgers exist, and note their exact names:
   - one **bank ledger** per non-cash mode you accept, e.g. `HDFC Bank A/c`
     (UPI, transfer) or `Card Settlement A/c` (card)
   - a **fee income** ledger, e.g. `Fees Received`
   - a **registration fee** ledger, e.g. `Registration Fees Received`
   - optionally a **late fee** ledger, e.g. `Late Fee Received`
4. Recommended: create a voucher type **ERP Receipt** under *Receipt* with
   *Method of voucher numbering* set to **Manual**. Tally then shows the ERP's
   receipt number, and ERP vouchers are easy to filter in Day Book.

### 2. In the ERP

1. Add `TALLY_BRIDGE_KEY` to the deployment's environment variables. Generate a
   long random value with:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   Then redeploy.
2. Apply the database migration (`npm run db:deploy`; the Vercel build runs it
   automatically).
3. Go to **Setup › Tally Prime** and fill in:
   - the company name and voucher type, exactly as in Tally
   - **Post receipts dated from**: nothing earlier is ever sent
   - the ledger for each payment mode, and the credit ledgers
   - tick **Post non-cash receipts to Tally Prime automatically**, then **Save**

### 3. On the Tally PC

1. Install **Node.js 18 or later** from nodejs.org (LTS).
2. Copy this `tally-bridge` folder to the PC, e.g. `C:\ManthanTallyBridge`.
3. Copy `bridge.env.example` to `bridge.env`. Set `ERP_URL`, and set
   `ERP_BRIDGE_KEY` to the same value as `TALLY_BRIDGE_KEY`.
4. Double-click **start-bridge.cmd**. You should see `Bridge started`.
5. To start it automatically at every logon, run **install-task.cmd** once.

Setup › Tally Prime now shows the bridge as **Online**.

## Before going live: test on a copy

Ledger naming, numbering and Edit Log settings differ between companies. Run the
first few vouchers against a **test company**, or a backup of the real one:

1. Record a small UPI receipt in the ERP. Within ~20 seconds it should show as
   **SYNCED** in Setup › Tally Prime and appear in Tally's Day Book.
2. Open the voucher in Tally. Check the bank, fee and late-fee lines and the
   narration.
3. Cancel that receipt in the ERP. The voucher should show as **Cancelled** in
   Tally, and **Edit Log** (Alt+Z on the voucher, or *Display More Reports ›
   Edit Log*) should show both events.

## What gets posted

| ERP                        | Tally voucher                                         |
|----------------------------|-------------------------------------------------------|
| Receipt number             | Voucher number (and `REMOTEID` to prevent duplicates) |
| Payment date               | Voucher date                                          |
| Mode (UPI, card, …)        | **Dr** the bank ledger you mapped to that mode        |
| Amount (less late fee)     | **Cr** fee ledger, or the student's own ledger        |
| Late fee portion           | **Cr** late fee ledger (only if one is set)           |
| Registration fee           | **Cr** registration fee ledger                        |
| Reference no. (UTR/cheque) | Voucher reference, plus the bank allocation if enabled |
| Student name, code, remarks| Narration                                             |
| Receipt cancelled          | Voucher **cancelled** (never deleted)                 |

*Credit to: a ledger per student* creates `Student Name (CODE)` under the group
you choose, the first time that student pays by a non-cash mode.

## When something fails

Setup › Tally Prime lists each voucher with Tally's own error message. Common
causes:

- **`Ledger '…' does not exist`**: the name in Setup doesn't match Tally
  exactly. Fix it, then click **Retry failed**.
- **`Voucher type '…' does not exist`**: same fix, for the voucher type.
- **Company not open / imported nothing**: open the company in Tally. Rows retry
  on their own (after 1, 2, 4… minutes, up to an hour; after 10 attempts they
  wait for **Retry failed**).
- **Voucher date outside the books period**: extend the company's period in Tally.
- **Bridge shows Offline**: the PC is off or `start-bridge.cmd` isn't running.
  Check `bridge.log` in this folder.

Posting the same receipt twice can never create two vouchers. Tally matches on
`REMOTEID` and updates the existing one instead.
