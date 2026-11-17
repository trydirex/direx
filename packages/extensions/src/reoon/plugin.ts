// SPDX-License-Identifier: AGPL-3.0-only
// Address verification through Reoon's power mode. The key travels in the query string, as Reoon
// asks, so no URL, response body or underlying error ever reaches a message or a log: a failure
// says only what went wrong in words written here.
import { definePlugin, type Credential, type VerificationResult, VERIFY_ADDRESS, VERIFY_BALANCE, verifyAddressInput, type VerifyAddressOutput, type VerifyBalanceOutput, PluginError } from "@direx/plugin-sdk";
import { reoonManifest } from "./manifest";

export const REOON_DEFAULTS = {
  /** What one charged check costs. Reoon's free tier charges nothing. */
  priceMicrosPerCredit: 0,
  /** Checks run one at a time, about one a second, well inside Reoon's limits. */
  intervalMs: 1000,
  /** Power mode talks to the mail server, which can take a while. */
  timeoutMs: 60_000,
};

export type ReoonOptions = Partial<typeof REOON_DEFAULTS> & { baseUrl?: string; fetch?: typeof fetch; now?: () => number };

/** Only `safe` is deliverable. `disabled` is a mailbox that no longer takes mail, so it counts as invalid. */
const RESULTS: Record<string, VerificationResult> = { safe: "deliverable", invalid: "invalid", disabled: "invalid", catch_all: "catch_all", unknown: "unknown" };
const UNCHARGED = new Set(["unknown"]);

function keyOf(c: Credential | null): string {
  const key = c && "key" in c ? c.key.trim() : "";
  if (!key) throw new PluginError("not_connected", "Reoon is not connected: add its API key in Credentials");
  return key;
}

export function createReoonPlugin(o: ReoonOptions = {}) {
  const cfg = { ...REOON_DEFAULTS, ...o };
  const baseUrl = o.baseUrl ?? "https://emailverifier.reoon.com";
  const http = o.fetch ?? fetch;
  const now = o.now ?? Date.now;

  // ponytail: one queue per plugin instance, shared by every Workspace. Fine for the pilot's volume;
  // a queue per key if several Workspaces verify at once.
  let tail: Promise<unknown> = Promise.resolve();
  let nextAt = 0;
  function paced<T>(call: () => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      const wait = nextAt - now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await call();
      } finally {
        nextAt = now() + cfg.intervalMs;
      }
    });
    tail = run.catch(() => undefined);
    return run;
  }

  /** The parsed body of a successful answer, or null for any failure, whatever its cause. */
  async function get(path: string, params: Record<string, string>): Promise<Record<string, unknown> | null> {
    try {
      const res = await http(`${baseUrl}${path}?${new URLSearchParams(params)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(cfg.timeoutMs) });
      const body = (await res.json().catch(() => null)) as unknown;
      return res.ok && body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async function verify(input: unknown, credential: Credential | null): Promise<VerifyAddressOutput> {
    const parsed = verifyAddressInput.safeParse(input);
    if (!parsed.success) throw new Error("email.verify takes { email } with one address");
    const key = keyOf(credential);
    const body = await paced(() => get("/api/v1/verify", { email: parsed.data.email, key, mode: "power" }));
    const status = typeof body?.status === "string" ? body.status : null;
    // Reoon reports its own failures, such as a refused key or no credits left, as status "error".
    // A refusal is not an answer, so it throws and the caller stores nothing.
    if (!status || status === "error") throw new Error("Reoon refused the check: no checks left, or the key was refused, or it could not be reached");
    const credits = UNCHARGED.has(status) ? 0 : 1;
    return { result: RESULTS[status] ?? "other", vendorStatus: status.slice(0, 100), credits, costMicros: credits * cfg.priceMicrosPerCredit };
  }

  async function balance(credential: Credential | null): Promise<VerifyBalanceOutput> {
    const key = keyOf(credential);
    const body = await paced(() => get("/api/v1/check-account-balance/", { key }));
    const daily = body?.remaining_daily_credits;
    const instant = body?.remaining_instant_credits;
    if (typeof daily !== "number" || typeof instant !== "number") throw new Error("Reoon refused the balance check, or could not be reached");
    return { remainingCredits: Math.max(0, Math.trunc(daily + instant)) };
  }

  return definePlugin({
    manifest: reoonManifest,
    queries: {
      [VERIFY_ADDRESS]: (input, ctx) => verify(input, ctx.credential),
      [VERIFY_BALANCE]: (_input, ctx) => balance(ctx.credential),
    },
  });
}
