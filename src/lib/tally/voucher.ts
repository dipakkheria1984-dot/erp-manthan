import type { PaymentKind, PaymentMode, TallyConfig } from "@/generated/prisma/client";

/**
 * Turning a receipt into Tally Prime XML, and reading Tally's answer back.
 *
 * Pure on purpose — no database, no network — so the exact bytes that reach
 * Tally can be inspected and tested in isolation. The outbox decides *when* a
 * voucher is sent; this file decides *what* is sent.
 *
 * The request shape is Tally's classic "Import Data" envelope, which every
 * TallyPrime release (Edit Log included) accepts on its XML port. Edit Log
 * needs nothing special from us: it records every voucher created, altered or
 * cancelled through the import on its own. What it does need is for us never
 * to *delete* — so a receipt voided in the ERP is cancelled in Tally, which
 * keeps the voucher, its number and its history visible to an auditor.
 */

/** Everything about a receipt the voucher needs, gathered from its lines. */
export type ReceiptForTally = {
  receiptNo: string;
  kind: PaymentKind;
  paymentDate: Date;
  mode: PaymentMode;
  referenceNo: string | null;
  remarks: string | null;
  totalPaise: number;
  lateFeePaise: number;
  /** Student once enrolled; the applicant for a registration receipt before that. */
  payer: { name: string; code: string | null; isStudent: boolean };
};

export type TallyRequest = {
  purpose: "ledger" | "voucher";
  /** Set when `purpose` is "ledger", so the acknowledgement can record it. */
  ledgerName?: string;
  xml: string;
};

const NON_CASH_MODES = ["UPI", "CARD", "BANK_TRANSFER", "CHEQUE", "OTHER"] as const;
export type NonCashMode = (typeof NON_CASH_MODES)[number];

export function isNonCash(mode: PaymentMode): mode is NonCashMode {
  return (NON_CASH_MODES as readonly string[]).includes(mode);
}

export const MODE_LABELS: Record<NonCashMode, string> = {
  UPI: "UPI",
  CARD: "Card",
  BANK_TRANSFER: "Bank transfer",
  CHEQUE: "Cheque",
  OTHER: "Other",
};

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

export function escapeXml(value: string): string {
  return stripControlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Control characters other than tab and newlines are not legal XML 1.0 and make
 * Tally reject the whole envelope; they only ever arrive by pasting into a
 * remarks box. Filtered by code point rather than a regex so no control
 * character has to appear in this source file.
 */
function stripControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
    out += ch;
  }
  return out;
}

/** `YYYYMMDD` in the process zone, which is IST — see src/lib/dates.ts. */
export function tallyDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** Rupees with two decimals, from integer paise. Never a float on the way in. */
export function tallyAmount(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * The key Tally matches an imported voucher on. Posting the same receipt twice
 * — a lost acknowledgement, a lease that expired mid-post — alters the voucher
 * already there instead of creating a second one.
 */
export function remoteIdFor(receiptNo: string): string {
  return `manthan-erp-receipt:${receiptNo}`;
}

export function studentLedgerName(payer: ReceiptForTally["payer"]): string {
  return payer.code ? `${payer.name} (${payer.code})` : payer.name;
}

/* -------------------------------------------------------------------------- */
/* Ledger mapping                                                              */
/* -------------------------------------------------------------------------- */

type LedgerConfig = Pick<
  TallyConfig,
  | "ledgerUpi"
  | "ledgerCard"
  | "ledgerBankTransfer"
  | "ledgerCheque"
  | "ledgerOther"
  | "creditMode"
  | "feeLedger"
  | "registrationLedger"
  | "lateFeeLedger"
  | "studentLedgerGroup"
  | "voucherTypeName"
  | "companyName"
  | "sendBankAllocations"
>;

/** The bank/settlement ledger money in this mode is debited to. */
export function debitLedgerFor(config: LedgerConfig, mode: NonCashMode): string | null {
  const byMode: Record<NonCashMode, string | null> = {
    UPI: config.ledgerUpi,
    CARD: config.ledgerCard,
    BANK_TRANSFER: config.ledgerBankTransfer,
    CHEQUE: config.ledgerCheque,
    OTHER: config.ledgerOther,
  };
  const name = byMode[mode]?.trim();
  return name ? name : null;
}

/**
 * The credit lines. A registration receipt always credits the registration
 * ledger — the applicant has no student code yet, and opening a ledger for
 * them would leave the person split across two ledgers once they enrol.
 */
export function creditLinesFor(
  config: LedgerConfig,
  receipt: ReceiptForTally,
): { ledger: string; paise: number }[] {
  const principalLedger =
    receipt.kind === "REGISTRATION" || !receipt.payer.isStudent
      ? config.registrationLedger
      : config.creditMode === "STUDENT"
        ? studentLedgerName(receipt.payer)
        : config.feeLedger;

  const lateFeeLedger = config.lateFeeLedger?.trim();
  if (lateFeeLedger && receipt.lateFeePaise > 0 && receipt.lateFeePaise < receipt.totalPaise) {
    return [
      { ledger: principalLedger, paise: receipt.totalPaise - receipt.lateFeePaise },
      { ledger: lateFeeLedger, paise: receipt.lateFeePaise },
    ];
  }
  return [{ ledger: principalLedger, paise: receipt.totalPaise }];
}

/** Whether this receipt credits a per-student ledger that may need creating. */
export function studentLedgerNeeded(config: LedgerConfig, receipt: ReceiptForTally): string | null {
  if (config.creditMode !== "STUDENT") return null;
  if (receipt.kind === "REGISTRATION" || !receipt.payer.isStudent) return null;
  return studentLedgerName(receipt.payer);
}

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                   */
/* -------------------------------------------------------------------------- */

function envelope(reportName: "Vouchers" | "All Masters", companyName: string | null, body: string): string {
  const company = companyName?.trim()
    ? `<STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(companyName.trim())}</SVCURRENTCOMPANY></STATICVARIABLES>`
    : "";
  return [
    "<ENVELOPE>",
    "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>",
    "<BODY><IMPORTDATA>",
    `<REQUESTDESC><REPORTNAME>${reportName}</REPORTNAME>${company}</REQUESTDESC>`,
    `<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${body}</TALLYMESSAGE></REQUESTDATA>`,
    "</IMPORTDATA></BODY>",
    "</ENVELOPE>",
  ].join("");
}

export function buildLedgerMasterXml(config: LedgerConfig, ledgerName: string): string {
  const name = escapeXml(ledgerName);
  return envelope(
    "All Masters",
    config.companyName,
    `<LEDGER NAME="${name}" ACTION="Create">` +
      `<NAME.LIST><NAME>${name}</NAME></NAME.LIST>` +
      `<PARENT>${escapeXml(config.studentLedgerGroup)}</PARENT>` +
      `<ISBILLWISEON>No</ISBILLWISEON>` +
      `</LEDGER>`,
  );
}

/** Tally's instrument types for bank allocations. */
const BANK_TRANSACTION_TYPE: Record<NonCashMode, string> = {
  UPI: "e-Fund Transfer",
  BANK_TRANSFER: "e-Fund Transfer",
  CHEQUE: "Cheque/DD",
  CARD: "Others",
  OTHER: "Others",
};

function narrationFor(receipt: ReceiptForTally): string {
  const who = receipt.payer.code ? `${receipt.payer.name} (${receipt.payer.code})` : receipt.payer.name;
  const what = receipt.kind === "REGISTRATION" ? "Registration fee" : "Fee";
  const parts = [
    `${what} received from ${who}`,
    `ERP receipt ${receipt.receiptNo}`,
    `mode ${MODE_LABELS[receipt.mode as NonCashMode] ?? receipt.mode}`,
  ];
  if (receipt.referenceNo) parts.push(`ref ${receipt.referenceNo}`);
  if (receipt.remarks) parts.push(receipt.remarks);
  return parts.join(" · ");
}

/**
 * A Receipt voucher: debit the bank ledger for the mode, credit fees.
 *
 * Tally's sign convention in XML is the reverse of what reads naturally — a
 * debit is ISDEEMEDPOSITIVE=Yes with a *negative* amount, a credit is No with a
 * positive one — and getting it backwards produces a voucher that imports
 * cleanly and is wrong. Hence it lives in exactly one place.
 */
export function buildReceiptVoucherXml(config: LedgerConfig, receipt: ReceiptForTally, debitLedger: string): string {
  const date = tallyDate(receipt.paymentDate);
  const voucherType = escapeXml(config.voucherTypeName);
  const credits = creditLinesFor(config, receipt);
  const partyLedger = credits[0].ledger;

  const bankAllocation =
    config.sendBankAllocations
      ? `<BANKALLOCATIONS.LIST>` +
        `<DATE>${date}</DATE>` +
        `<INSTRUMENTDATE>${date}</INSTRUMENTDATE>` +
        `<TRANSACTIONTYPE>${BANK_TRANSACTION_TYPE[receipt.mode as NonCashMode] ?? "Others"}</TRANSACTIONTYPE>` +
        (receipt.referenceNo ? `<INSTRUMENTNUMBER>${escapeXml(receipt.referenceNo)}</INSTRUMENTNUMBER>` : "") +
        `<PAYMENTFAVOURING>${escapeXml(receipt.payer.name)}</PAYMENTFAVOURING>` +
        `<AMOUNT>${tallyAmount(-receipt.totalPaise)}</AMOUNT>` +
        `</BANKALLOCATIONS.LIST>`
      : "";

  const creditEntries = credits
    .map(
      (line) =>
        `<ALLLEDGERENTRIES.LIST>` +
        `<LEDGERNAME>${escapeXml(line.ledger)}</LEDGERNAME>` +
        `<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` +
        `<AMOUNT>${tallyAmount(line.paise)}</AMOUNT>` +
        `</ALLLEDGERENTRIES.LIST>`,
    )
    .join("");

  const debitEntry =
    `<ALLLEDGERENTRIES.LIST>` +
    `<LEDGERNAME>${escapeXml(debitLedger)}</LEDGERNAME>` +
    `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>` +
    `<AMOUNT>${tallyAmount(-receipt.totalPaise)}</AMOUNT>` +
    bankAllocation +
    `</ALLLEDGERENTRIES.LIST>`;

  return envelope(
    "Vouchers",
    config.companyName,
    `<VOUCHER REMOTEID="${escapeXml(remoteIdFor(receipt.receiptNo))}" VCHTYPE="${voucherType}" ACTION="Create" OBJVIEW="Accounting Voucher View">` +
      `<DATE>${date}</DATE>` +
      `<EFFECTIVEDATE>${date}</EFFECTIVEDATE>` +
      `<VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME>` +
      `<VOUCHERNUMBER>${escapeXml(receipt.receiptNo)}</VOUCHERNUMBER>` +
      (receipt.referenceNo ? `<REFERENCE>${escapeXml(receipt.referenceNo)}</REFERENCE>` : "") +
      `<PARTYLEDGERNAME>${escapeXml(partyLedger)}</PARTYLEDGERNAME>` +
      `<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>` +
      `<NARRATION>${escapeXml(narrationFor(receipt))}</NARRATION>` +
      creditEntries +
      debitEntry +
      `</VOUCHER>`,
  );
}

/**
 * Cancel the voucher for a voided receipt.
 *
 * Found by Tally's MASTERID when the create acknowledgement gave us one, which
 * survives renumbering inside Tally; otherwise by voucher number.
 */
export function buildCancelVoucherXml(
  config: LedgerConfig,
  receipt: Pick<ReceiptForTally, "receiptNo" | "paymentDate">,
  masterId: string | null,
  reason: string | null,
): string {
  const date = tallyDate(receipt.paymentDate);
  const voucherType = escapeXml(config.voucherTypeName);
  const locate = masterId
    ? `TAGNAME="MasterID" TAGVALUE="${escapeXml(masterId)}"`
    : `TAGNAME="Voucher Number" TAGVALUE="${escapeXml(receipt.receiptNo)}"`;
  const narration = `Cancelled in ERP — receipt ${receipt.receiptNo}${reason ? ` · ${reason}` : ""}`;
  return envelope(
    "Vouchers",
    config.companyName,
    `<VOUCHER DATE="${date}" ${locate} VCHTYPE="${voucherType}" ACTION="Cancel">` +
      `<NARRATION>${escapeXml(narration)}</NARRATION>` +
      `</VOUCHER>`,
  );
}

/* -------------------------------------------------------------------------- */
/* Reading Tally's answer                                                      */
/* -------------------------------------------------------------------------- */

export type TallyImportResult = {
  ok: boolean;
  created: number;
  altered: number;
  cancelled: number;
  errors: number;
  exceptions: number;
  lastVoucherId: string | null;
  messages: string[];
};

function count(text: string, tag: string): number {
  const match = text.match(new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, "i"));
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Tally answers HTTP 200 whether or not anything was imported; the counts in
 * the body are the only truth. A voucher that failed validation shows up as
 * ERRORS=1 with a LINEERROR explaining why, and nothing else.
 */
export function parseTallyResponse(body: string): TallyImportResult {
  const messages = [...body.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)].map((m) => m[1].trim()).filter(Boolean);
  const lastVch = body.match(/<LASTVCHID>\s*(\d+)\s*<\/LASTVCHID>/i)?.[1] ?? null;

  const result: TallyImportResult = {
    ok: false,
    created: count(body, "CREATED"),
    altered: count(body, "ALTERED") + count(body, "COMBINED"),
    cancelled: count(body, "CANCELLED"),
    errors: count(body, "ERRORS"),
    exceptions: count(body, "EXCEPTIONS"),
    lastVoucherId: lastVch && lastVch !== "0" ? lastVch : null,
    messages,
  };

  const landed = result.created + result.altered + result.cancelled > 0;
  result.ok = landed && result.errors === 0 && result.exceptions === 0 && messages.length === 0;

  if (!result.ok && messages.length === 0) {
    if (!/<RESPONSE>|<ENVELOPE>/i.test(body)) {
      messages.push(`Unexpected reply from Tally: ${body.slice(0, 200) || "(empty)"}`);
    } else if (result.exceptions > 0) {
      messages.push("Tally raised an exception — usually a ledger or voucher type that does not exist in this company.");
    } else if (!landed) {
      messages.push("Tally accepted the request but imported nothing. Check that the company is open.");
    }
  }
  return result;
}

/** A ledger master that already exists is not a failure — it is what we wanted. */
export function ledgerAlreadyExists(result: TallyImportResult): boolean {
  return result.messages.some((message) => /already exists/i.test(message));
}
