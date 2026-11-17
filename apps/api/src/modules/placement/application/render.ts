// SPDX-License-Identifier: AGPL-3.0-only
// The text of a Placement check. A plain check is a library entry chosen from the sender, the
// receiver and how many days the pair has been listed together; a content check is a Campaign template step filled with placeholder values.
// Both end with the footer a real send has, with no unsubscribe link: a check suppresses no one and
// names no Workspace.
import { createHash } from "node:crypto";
import { merge, type StepUrls } from "../../campaigns/index";
import { optOutFooter } from "../../outreach/index";
import { LIBRARY, LIBRARY_APPROVED } from "../domain/library";

export type Sender = { address: string; name: string; postalAddress: string };
export type Probe = { subject: string; text: string };

/** Every merge field of a content check, whoever the step was written for. */
export const PLACEHOLDERS = { firstName: "Alex", company: "Example Ltd" } as const;

const norm = (a: string) => a.trim().toLowerCase();
const footer = (s: Pick<Sender, "name" | "postalAddress">) => optOutFooter({ senderName: s.name, postalAddress: s.postalAddress, unsubscribeUrl: null });

/**
 * The library entry of a pair's plain check number `n`, counted over the pair's whole history, so
 * it does not depend on the day's seed. Each run of LIBRARY.length checks is its own shuffle of the
 * whole library, so a pair sees every entry once before any repeats. The receiver recomputes it to
 * know what subject to look for.
 */
export function plainEntry(senderAddress: string, receiverAddress: string, n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("n must be a whole number from 0");
  const key = [norm(senderAddress), norm(receiverAddress), Math.floor(n / LIBRARY.length)].join("\n");
  const rank = LIBRARY.map((_, i) => createHash("sha256").update(`${key}\n${i}`).digest("hex"));
  const order = LIBRARY.map((_, i) => i).sort((a, b) => (rank[a]! < rank[b]! ? -1 : 1));
  return order[n % LIBRARY.length]!;
}

/** The subject a receiver expects for this check. */
export const plainSubject = (senderAddress: string, receiverAddress: string, n: number): string => LIBRARY[plainEntry(senderAddress, receiverAddress, n)]![0];

/** The text of a plain check, whether or not the library is approved yet; plainProbe is the one that sends use. */
export function renderPlain(sender: Sender, receiverAddress: string, n: number): Probe {
  const [subject, body] = LIBRARY[plainEntry(sender.address, receiverAddress, n)]!;
  return { subject, text: `${body.replaceAll("{sender}", sender.name)}\n\n${footer(sender)}` };
}

/** A plain check, only once the library text is approved. */
export function plainProbe(sender: Sender, receiverAddress: string, n: number): Probe {
  if (!LIBRARY_APPROVED) throw new Error("the plain Placement check library is not approved yet");
  return renderPlain(sender, receiverAddress, n);
}

/** A template step filled with the placeholders, the real sender name and the step URLs; lists what is missing otherwise. */
export function contentProbe(template: Probe, stepUrls: StepUrls, sender: Pick<Sender, "name" | "postalAddress">): { ok: true; probe: Probe } | { ok: false; missing: string[] } {
  const values = { ...PLACEHOLDERS, senderName: sender.name };
  const subject = merge(template.subject, values, stepUrls);
  const text = merge(template.text, values, stepUrls);
  if (!subject.ok || !text.ok) return { ok: false, missing: [...(subject.ok ? [] : subject.missing), ...(text.ok ? [] : text.missing)] };
  return { ok: true, probe: { subject: subject.text, text: `${text.text}\n\n${footer(sender)}` } };
}
