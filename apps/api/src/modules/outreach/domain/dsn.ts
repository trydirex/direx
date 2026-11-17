// SPDX-License-Identifier: AGPL-3.0-only
// Pure: which delivery statuses mean the address itself is gone. A 5.7.x says more about our sending
// than about the Person, so it stops nothing here.
const HARD = new Set(["5.1.1", "5.1.2", "5.1.3", "5.1.6", "5.1.10", "5.2.1"]);

export const isHardBounce = (status: string | null): boolean => status !== null && HARD.has(status);
export const isPermanentFailure = (status: string | null): boolean => status?.startsWith("5.") ?? false;

/**
 * A notice that names who failed but gives no status, as X-Failed-Recipients does, still failed for
 * good. When it names one address, the code in its text says why.
 */
// ponytail: a delivery-status block missing its required Status line counts as failed too; read its Action field if delayed notices show up that way.
export function statusOf(status: string | null, text: string, recipients: number): string {
  if (status) return status;
  const code = recipients === 1 ? /(?<![\d.])5\.\d{1,3}\.\d{1,3}(?![\d.])/.exec(text)?.[0] : undefined;
  return code ?? "5.0.0";
}
