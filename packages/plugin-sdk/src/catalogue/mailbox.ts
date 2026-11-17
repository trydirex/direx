// SPDX-License-Identifier: MIT
// What a Mailbox answers: whose it is, and a probe it sent to itself, read back where it landed.
import { z } from "zod";
import { noInput } from "./entry";

export const mailboxProfile = {
  name: "mailbox.profile",
  version: 1,
  input: noInput,
  // hasSent: whether the account has a Sent folder to read, from a provider that can tell.
  output: z.strictObject({ emailAddress: z.string().min(1).max(320), hasSent: z.boolean().optional() }),
} as const;

export const mailboxProbeRead = {
  name: "mailbox.probe_read",
  version: 1,
  input: z.strictObject({
    actionId: z.string().regex(/^[0-9a-zA-Z-]{1,200}$/, "a plain token"),
    subject: z.string().min(1).max(998).regex(/^[^\r\n]*$/, "one line"),
  }),
  // The raw header block as it arrived, and the start of the text and HTML.
  output: z.discriminatedUnion("found", [
    z.strictObject({ found: z.literal(false) }),
    z.strictObject({ found: z.literal(true), folder: z.enum(["inbox", "junk"]), headers: z.string(), text: z.string(), html: z.string().nullable() }),
  ]),
} as const;
