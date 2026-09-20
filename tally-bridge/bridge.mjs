#!/usr/bin/env node
/**
 * Manthan ERP → Tally Prime bridge.
 *
 * Runs on the PC where TallyPrime (Edit Log) is open. Every few seconds it:
 *   1. checks Tally is answering on its XML port (default localhost:9000),
 *   2. asks the ERP for vouchers waiting to be posted,
 *   3. posts each one to Tally, in order,
 *   4. reports Tally's raw reply back to the ERP.
 *
 * It holds no state and makes no decisions. Which receipts go, how they are
 * mapped to ledgers, and whether Tally accepted them are all decided in the ERP,
 * so changing any of that never means touching this PC again.
 *
 * No dependencies — Node 18 or later is all it needs.
 *
 * Configuration comes from environment variables, or from `bridge.env` beside
 * this file (KEY=value per line):
 *   ERP_URL          https://your-erp.example.com          (required)
 *   ERP_BRIDGE_KEY   same value as TALLY_BRIDGE_KEY on the ERP (required)
 *   TALLY_URL        http://localhost:9000                 (default)
 *   POLL_SECONDS     20                                    (default)
 *   BATCH_SIZE       10                                    (default)
 */

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(HERE, "bridge.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/* ---------------------------------------------------------------- config -- */

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(join(HERE, "bridge.env"));

const ERP_URL = (process.env.ERP_URL ?? "").replace(/\/$/, "");
const ERP_BRIDGE_KEY = process.env.ERP_BRIDGE_KEY ?? "";
const TALLY_URL = (process.env.TALLY_URL ?? "http://localhost:9000").replace(/\/$/, "");
const POLL_SECONDS = Math.max(5, Number.parseInt(process.env.POLL_SECONDS ?? "20", 10) || 20);
const BATCH_SIZE = Math.min(50, Math.max(1, Number.parseInt(process.env.BATCH_SIZE ?? "10", 10) || 10));

if (!ERP_URL || !ERP_BRIDGE_KEY) {
  console.error("ERP_URL and ERP_BRIDGE_KEY must be set (in bridge.env or the environment).");
  process.exit(1);
}

/* --------------------------------------------------------------- logging -- */

function log(level, message) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}`;
  (level === "ERROR" ? console.error : console.log)(line);
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // A full disk must not stop vouchers flowing.
  }
}

/* ------------------------------------------------------------------ http -- */

async function erp(path, body) {
  const response = await fetch(`${ERP_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tally-key": ERP_BRIDGE_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ERP ${path} answered HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Tally answers a plain GET on its port with "TallyPrime Server is Running". */
async function tallyOnline() {
  try {
    const response = await fetch(TALLY_URL, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function postToTally(xml) {
  const response = await fetch(TALLY_URL, {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: xml,
    // A large company can take a while to validate a voucher; this is generous
    // on purpose, because a timeout here is ambiguous — the voucher may still land.
    signal: AbortSignal.timeout(90_000),
  });
  return { httpStatus: response.status, body: (await response.text()).slice(0, 20_000) };
}

/* ------------------------------------------------------------------ loop -- */

let warnedOffline = false;

async function pass() {
  const online = await tallyOnline();
  if (!online && !warnedOffline) log("WARN", `Tally is not answering at ${TALLY_URL}. Is TallyPrime open with the company loaded?`);
  if (online && warnedOffline) log("INFO", "Tally is answering again.");
  warnedOffline = !online;

  // Offline, this is a heartbeat only: nothing is leased that could not be delivered.
  const { enabled, jobs } = await erp("/api/tally/pull", { limit: online ? BATCH_SIZE : 0, tallyOnline: online });
  if (!enabled || jobs.length === 0) return;

  const results = [];
  for (const job of jobs) {
    const result = { id: job.id, responses: [] };
    try {
      for (const request of job.requests) {
        const reply = await postToTally(request.xml);
        result.responses.push({ purpose: request.purpose, ledgerName: request.ledgerName, ...reply });
      }
    } catch (error) {
      result.transportError = `Could not reach Tally: ${error instanceof Error ? error.message : String(error)}`;
      delete result.responses;
    }
    results.push(result);
  }

  const { outcomes } = await erp("/api/tally/ack", { results });
  for (const job of jobs) {
    const outcome = outcomes?.[job.id] ?? "unknown";
    log(outcome === "synced" ? "INFO" : "WARN", `${job.action === "CREATE" ? "Post" : "Cancel"} ${job.receiptNo}: ${outcome}`);
  }
}

log("INFO", `Bridge started. ERP ${ERP_URL} · Tally ${TALLY_URL} · every ${POLL_SECONDS}s`);

// Passes never overlap: the next one is scheduled only once this one is done.
async function loop() {
  try {
    await pass();
  } catch (error) {
    log("ERROR", error instanceof Error ? error.message : String(error));
  }
  setTimeout(loop, POLL_SECONDS * 1000);
}
loop();
