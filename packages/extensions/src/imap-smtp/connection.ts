// SPDX-License-Identifier: AGPL-3.0-only
// The server settings a basic credential carries, and how the plugin connects. TLS is always on
// and certificates are always verified; the two test switches are reachable only from the factory
// call in a test, never from a credential.
import type { Credential } from "@direx/plugin-sdk";
import { z } from "zod";

const host = z.string().regex(/^[A-Za-z0-9.-]{1,253}$/, "not a host name");
const port = z.string().regex(/^\d{1,5}$/, "not a port").transform(Number);

export const serverSettings = z.object({
  smtpHost: host,
  smtpPort: port,
  imapHost: host,
  imapPort: port,
  fromAddress: z.string().regex(/^[^\s@<>]+@[^\s@<>]+$/, "not an email address"),
  fromName: z.string().max(200).regex(/^[^\r\n]*$/, "line breaks are not allowed").optional(),
});

export type Connection = z.infer<typeof serverSettings> & { username: string; password: string };

export type ConnectOptions = {
  timeoutMs: number;
  test?: { untrustedCerts?: boolean; plainSmtp?: boolean; implicitTlsPort?: number };
};

/** The credential as a connection, or null when it isn't a complete basic one. */
export function connectionOf(c: Credential | null): Connection | null {
  if (!c || !("password" in c)) return null;
  const s = serverSettings.safeParse(c.settings);
  return s.success ? { ...s.data, username: c.username, password: c.password } : null;
}

export const tlsOptions = (o: ConnectOptions) => (o.test?.untrustedCerts ? { tls: { rejectUnauthorized: false } } : {});
