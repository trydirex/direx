// SPDX-License-Identifier: AGPL-3.0-only
// Pure: whether a network on the internet could fetch from this address. A self-hosted Direx on a laptop
// or a home network can't be reached, so a network that fetches a file itself gets a hand post instead.

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./];
const LOCAL_NAMES = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/;

/** HTTPS on a name or address the internet can reach. Anything unparseable is not public. */
export function isPublicUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    return !(v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("::ffff:"));
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !PRIVATE_V4.some((r) => r.test(host));
  return host.includes(".") && !LOCAL_NAMES.test(host);
}
