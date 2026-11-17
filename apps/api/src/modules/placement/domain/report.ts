// SPDX-License-Identifier: AGPL-3.0-only
// The daily report a receiving Mailbox sends one sender: for each check it expected from that sender,
// its kind, the verdict and the Message-ID it saw (none for a check not found), each entry signed with the receiver's member key. Nothing else
// from the receiver's mailbox goes in. The receiver writes it and the sender reads it, both from here.
// Reading is strict: a body that isn't exactly what reportText writes is not a report.
import { canonical } from "./canonical";

export const REPORT_SUBJECT = "Placement report";
const FORMAT = "direx-placement-report-1";
/** Entries one report carries, so the body stays well inside what an inbound event's text holds. */
export const REPORT_ENTRIES = 12;

const VERDICTS = new Set(["primary", "other_tab", "spam", "missing", "query_failure"]);
const KINDS = new Set(["plain", "content"]);
const ADDRESS = /^[^\s@<>A-Z]+@[^\s@<>A-Z]+\.[^\s@<>A-Z]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MESSAGE_ID = /^<[^\s<>]{1,900}>$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;

/** What the receiver's member key signs for one check. */
export type ReportFields = { list_version: number; day: string; sender: string; receiver: string; kind: string; message_id: string | null; verdict: string };
export type ReportEntry = Omit<ReportFields, "sender" | "receiver"> & { sig: string };
export type Report = { format: typeof FORMAT; sender: string; receiver: string; entries: ReportEntry[] };

/** The exact bytes the member key signs: the seven fields as canonical JSON. */
export const reportSigned = (f: ReportFields) => canonical({ list_version: f.list_version, day: f.day, sender: f.sender, receiver: f.receiver, kind: f.kind, message_id: f.message_id, verdict: f.verdict });

// A regex test coerces its argument, so each field is checked to be a string first.
const is = (re: RegExp, v: unknown) => typeof v === "string" && re.test(v);
const validEntry = (e: ReportEntry) =>
  typeof e === "object" &&
  e !== null &&
  Number.isInteger(e.list_version) &&
  e.list_version >= 1 &&
  is(DAY, e.day) &&
  KINDS.has(e.kind) &&
  VERDICTS.has(e.verdict) &&
  // A check not found has no Message-ID; any other verdict names the one the receiver saw.
  (e.verdict === "missing" ? e.message_id === null : is(MESSAGE_ID, e.message_id)) &&
  is(SIG, e.sig);
const valid = (r: Report) => r.format === FORMAT && is(ADDRESS, r.sender) && is(ADDRESS, r.receiver) && r.entries.length >= 1 && r.entries.length <= REPORT_ENTRIES && r.entries.every(validEntry);

/** The report's whole text body. */
export function reportText(sender: string, receiver: string, entries: ReportEntry[]): string {
  const r: Report = { format: FORMAT, sender, receiver, entries: entries.map((e) => ({ list_version: e.list_version, day: e.day, kind: e.kind, message_id: e.message_id, verdict: e.verdict, sig: e.sig })) };
  if (!valid(r)) throw new Error("not a placement report");
  return JSON.stringify(r);
}

/** The report in a text body, or null when the body is anything but one reportText wrote. */
export function parseReport(text: string): Report | null {
  const body = text.trim();
  if (!body.startsWith(`{"format":"${FORMAT}"`)) return null;
  let r: Report;
  try {
    r = JSON.parse(body) as Report;
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || !Array.isArray(r.entries)) return null;
  try {
    return reportText(r.sender, r.receiver, r.entries) === body ? r : null;
  } catch {
    return null;
  }
}
