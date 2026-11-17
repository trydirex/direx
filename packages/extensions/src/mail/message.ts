// SPDX-License-Identifier: AGPL-3.0-only
// The RFC 5322 message every mail plugin sends. prepare checks the input and returns the spec a
// person approves; rfc5322 turns that spec plus the ledger Action id into the same bytes every
// time. The Action id travels in X-Direx-Action, which lets a cut-off send be found again.
import { effectSchemas } from "@direx/plugin-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// What Direx passes to prepare, as the SDK catalogue describes it (ADR 0028 rule 001).
export const mailInput = effectSchemas("email.send").input;
const recipient = mailInput.shape.to.element;
export type Recipient = z.infer<typeof recipient>;

/** The fields that join the input in what a person approves: the multipart boundary and the host's Touch. */
export const specFields = { boundary: z.string().regex(/^[0-9a-f]{32}$/), touch: z.unknown().optional() };
export const mailSpec = mailInput.extend(specFields);
export type MailSpec = z.infer<typeof mailSpec>;

const display = (r: Recipient) => (typeof r === "string" ? r : `${r.name} <${r.address}>`);
export const addressOf = (r: Recipient) => (typeof r === "string" ? r : r.address);

/** Checks the input against the plugin's schema; throws with each problem's field named. */
export function prepareWith<S extends z.ZodType<z.infer<typeof mailInput>>>(schema: S, input: unknown): { spec: z.infer<S> & { boundary: string }; preview: string } {
  const r = schema.safeParse(input);
  if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  const spec = { ...r.data, boundary: randomUUID().replaceAll("-", "") };
  const lines = [`To: ${spec.to.map(display).join(", ")}`];
  if (spec.cc?.length) lines.push(`Cc: ${spec.cc.map(display).join(", ")}`);
  lines.push(`Subject: ${spec.subject}`, "", spec.text.slice(0, 500));
  return { spec, preview: lines.join("\n") };
}

const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded words of at most 64 characters, split on character boundaries, so a
 * folded header line stays within the 78 characters RFC 5322 asks for. */
function encodeWords(s: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 39) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

const headerText = (s: string) => (ascii(s) ? s : encodeWords(s));

function mailbox(r: Recipient): string {
  if (typeof r === "string") return r;
  const name = ascii(r.name) ? `"${r.name.replace(/["\\]/g, "\\$&")}"` : encodeWords(r.name);
  return `${name} <${r.address}>`;
}

function base64Body(s: string): string {
  return (Buffer.from(s).toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");
}

function part(type: "plain" | "html", body: string): string {
  return [`Content-Type: text/${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", base64Body(body)].join("\r\n");
}

/** What a provider doesn't fill in for itself. Gmail's API sets these; SMTP needs them from us. */
export type Envelope = { from: Recipient; date: Date; messageId: string };

/**
 * The RFC 5322 bytes of an approved message. A Placement check leaves out X-Direx-Action, so the
 * receiving member never sees a sender's Action id; it is found again by subject and send window.
 */
export function rfc5322(spec: MailSpec, actionId: string, envelope?: Envelope, opts: { actionHeader?: boolean } = {}): string {
  if (!/^[0-9a-zA-Z-]+$/.test(actionId)) throw new Error("the Action id must be a plain token");
  const h: string[] = [];
  if (envelope) h.push(`From: ${mailbox(envelope.from)}`, `Date: ${envelope.date.toUTCString()}`, `Message-ID: ${envelope.messageId}`);
  h.push(`To: ${spec.to.map(mailbox).join(",\r\n ")}`);
  if (spec.cc?.length) h.push(`Cc: ${spec.cc.map(mailbox).join(",\r\n ")}`);
  h.push(`Subject: ${headerText(spec.subject)}`);
  if (spec.inReplyTo) h.push(`In-Reply-To: ${spec.inReplyTo}`);
  if (spec.references?.length) h.push(`References: ${spec.references.join(" ")}`);
  if (spec.listUnsubscribe) h.push(`List-Unsubscribe: <${spec.listUnsubscribe}>`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  if (opts.actionHeader !== false) h.push(`X-Direx-Action: ${actionId}`);
  h.push("MIME-Version: 1.0");
  let body: string;
  if (spec.html === undefined) {
    body = part("plain", spec.text);
  } else {
    const b = spec.boundary;
    body = [
      `Content-Type: multipart/alternative; boundary="${b}"`,
      "",
      `--${b}`,
      part("plain", spec.text),
      `--${b}`,
      part("html", spec.html),
      `--${b}--`,
      "",
    ].join("\r\n");
  }
  return `${h.join("\r\n")}\r\n${body}`;
}
