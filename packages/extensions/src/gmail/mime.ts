// SPDX-License-Identifier: AGPL-3.0-only
// Gmail's form of the shared message: it can name a thread, and takes the bytes base64url encoded.
// There is no Message-ID: Gmail replaces any we set (smoke check, 2026-10-29).
import { z } from "zod";
import { mailInput, prepareWith, rfc5322, specFields } from "../mail/message";

export const sendInput = mailInput.extend({
  // Letters and digits only, so never a line break.
  threadId: z.string().regex(/^[0-9a-zA-Z]+$/, "a Gmail thread id").optional(),
});
export type SendInput = z.infer<typeof sendInput>;

/** What the approval binds: the input as checked, plus the multipart boundary and the host's Touch. */
export const gmailSpec = sendInput.extend(specFields);
export type GmailSpec = z.infer<typeof gmailSpec>;

export type Prepared = { spec: GmailSpec; preview: string };

export const prepareMessage = (input: unknown): Prepared => prepareWith(sendInput, input);

/** The message as Gmail's raw field: base64url of the RFC 5322 bytes. */
export const encodeRaw = (spec: GmailSpec, actionId: string, opts: { actionHeader?: boolean } = {}): string => Buffer.from(rfc5322(spec, actionId, undefined, opts)).toString("base64url");
