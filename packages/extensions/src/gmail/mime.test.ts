// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { rfc5322 } from "../mail/message";
import { encodeRaw, prepareMessage } from "./mime";

const ACTION = "6f1c2a9e-0b7d-4c1e-9a55-3d2f8e7b1c00";
const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
const headerBlock = (msg: string) => msg.split("\r\n\r\n")[0]!;
const unfold = (h: string) => h.replace(/\r\n[ \t]/g, " ");
const decodeWords = (s: string) =>
  s.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_, b) => Buffer.from(b, "base64").toString("utf8")).trim();
const errorOf = (input: unknown) => {
  try {
    prepareMessage(input);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

const base = { to: ["kim@example.com"], subject: "Quick question", text: "Hi Kim,\nare you free Tuesday?" };

test("prepare returns the spec and a preview; one spec always encodes to the same bytes", () => {
  const { spec, preview } = prepareMessage(base);
  expect(spec).toMatchObject(base);
  expect(spec.boundary).toMatch(/^[0-9a-f]{32}$/);
  expect(preview).toBe("To: kim@example.com\nSubject: Quick question\n\nHi Kim,\nare you free Tuesday?");
  expect(encodeRaw(spec, ACTION)).toBe(encodeRaw(spec, ACTION));
  const head = headerBlock(decode(encodeRaw(spec, ACTION)));
  expect(head).not.toMatch(/^Message-ID:/im);
  expect(head).toContain(`X-Direx-Action: ${ACTION}`);
  expect(head).toContain("Content-Type: text/plain; charset=UTF-8");
  expect(prepareMessage(base).spec.boundary).not.toBe(spec.boundary);
});

test("a Placement check can leave out X-Direx-Action and sets no Message-ID; nothing else changes", () => {
  const { spec } = prepareMessage(base);
  const without = rfc5322(spec, ACTION, undefined, { actionHeader: false });
  expect(headerBlock(without)).not.toMatch(/X-Direx-Action|Message-ID/i);
  expect(without).not.toContain(ACTION);
  expect(rfc5322(spec, ACTION).replace(`X-Direx-Action: ${ACTION}\r\n`, "")).toBe(without);
});

test("a line break in any header, a bad address or no recipient is refused with the field named", () => {
  expect(errorOf({ ...base, subject: "Hi\r\nBcc: everyone@example.com" })).toMatch(/^subject: line breaks are not allowed/);
  expect(errorOf({ ...base, to: [{ name: "Kim\nBcc: x@example.com", address: "kim@example.com" }] })).toMatch(/^to\.0/);
  expect(errorOf({ ...base, inReplyTo: "<a@b>\r\nX: y" })).toMatch(/^inReplyTo/);
  expect(errorOf({ ...base, references: ["<a@b>", "<c@d>\n"] })).toMatch(/^references\.1/);
  expect(errorOf({ ...base, to: ["not an address"] })).toMatch(/^to\.0/);
  expect(errorOf({ ...base, cc: ["kim@example.com, eve@example.com"] })).toMatch(/^cc\.0/);
  expect(errorOf({ ...base, to: [] })).toMatch(/^to: at least one recipient/);
  expect(errorOf({ ...base, bcc: ["x@example.com"] })).toMatch(/bcc/);
});

test("non-ASCII subjects and names are encoded words; header lines fold within 78 characters", () => {
  const subject = "Grüße aus München: ein sehr langer Betreff, der über mehrere Wörter geht ✓";
  const { spec } = prepareMessage({ ...base, subject, to: [{ name: "Zoë Müller", address: "zoe@example.com" }, { name: 'Kim "K" Lee', address: "kim@example.com" }] });
  const head = headerBlock(decode(encodeRaw(spec, ACTION)));
  for (const line of head.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
  const lines = unfold(head).split("\r\n");
  expect(decodeWords(lines.find((l) => l.startsWith("Subject: "))!.slice(9))).toBe(subject);
  const to = lines.find((l) => l.startsWith("To: "))!;
  expect(decodeWords(to.slice(4).split(" <zoe")[0]!)).toBe("Zoë Müller");
  expect(to).toContain('"Kim \\"K\\" Lee" <kim@example.com>');
});

test("HTML gives multipart/alternative with the text part first; reply fields are set", () => {
  const { spec } = prepareMessage({
    ...base,
    html: "<p>Hi Kim</p>",
    inReplyTo: "<abc@example.com>",
    references: ["<root@example.com>", "<abc@example.com>"],
    threadId: "18c2f",
  });
  const msg = decode(encodeRaw(spec, ACTION));
  const head = headerBlock(msg);
  expect(head).toContain(`Content-Type: multipart/alternative; boundary="${spec.boundary}"`);
  expect(head).toContain("In-Reply-To: <abc@example.com>");
  expect(head).toContain("References: <root@example.com> <abc@example.com>");
  expect(msg.indexOf("text/plain")).toBeLessThan(msg.indexOf("text/html"));
  expect(msg.trimEnd().endsWith(`--${spec.boundary}--`)).toBe(true);
  const parts = msg.split(`--${spec.boundary}`).slice(1, 3);
  const body = (p: string) => Buffer.from(p.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8");
  expect(parts.map(body)).toEqual([base.text, "<p>Hi Kim</p>"]);
});
