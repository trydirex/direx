// SPDX-License-Identifier: AGPL-3.0-only
// What the world says about a tracking domain: its CNAME and TXT records, and whether a TLS handshake
// on it succeeds with a trusted certificate (ADR 0035 rule 007). Tests pass their own.
import { resolveCname, resolveTxt } from "node:dns/promises";
import { connect } from "node:tls";

/** The label the TXT record sits under: `_direx-tracking.<hostname>`. */
export const TXT_LABEL = "_direx-tracking";

export type DnsLookup = {
  records(hostname: string): Promise<{ cname: string[]; txt: string[] }>;
  handshake(hostname: string): Promise<boolean>;
};

const HANDSHAKE_MS = 10_000;

// A missing record is an empty answer, not a failure: the check then reports what's missing.
const orEmpty = <T>(p: Promise<T[]>): Promise<T[]> => p.catch(() => []);

export const systemDns: DnsLookup = {
  async records(hostname) {
    const [cname, txt] = await Promise.all([orEmpty(resolveCname(hostname)), orEmpty(resolveTxt(`${TXT_LABEL}.${hostname}`))]);
    return { cname, txt: txt.map((parts) => parts.join("")) };
  },
  handshake(hostname) {
    return new Promise((resolve) => {
      const socket = connect({ host: hostname, port: 443, servername: hostname, timeout: HANDSHAKE_MS }, () => {
        resolve(socket.authorized);
        socket.end();
      });
      socket.on("timeout", () => (socket.destroy(), resolve(false)));
      socket.on("error", () => resolve(false));
    });
  },
};
