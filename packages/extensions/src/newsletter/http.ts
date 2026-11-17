// SPDX-License-Identifier: AGPL-3.0-only
// What every newsletter plugin does the same way: one authorised call with a timeout, and what a
// failed answer means. Error messages hold the tool and status only, never a key or a body.
import { PluginError, type PluginReason } from "@direx/plugin-sdk";
export type NewsletterHttp = { tool: string; baseUrl: string; fetch: typeof fetch; timeoutMs: number; headers: Record<string, string> };

/** The host's reason for a provider's HTTP status. */
export const reasonOfStatus = (status: number): PluginReason => (status === 401 ? "credential_rejected" : status === 429 ? "rate_limited" : status === 404 ? "not_found" : "provider_error");

export class NewsletterHttpError extends PluginError {
  /** Always set: these come from an HTTP answer. */
  declare readonly status: number;
  /** The tool refused the key, so a person must reconnect. */
  readonly credentialRejected: boolean;
  constructor(
    tool: string,
    status: number,
    /** Set for a 429: how long to wait before asking again. */
    readonly retryAfterMs?: number,
  ) {
    super(reasonOfStatus(status), `${tool} answered ${status}${retryAfterMs === undefined ? "" : `; wait ${retryAfterMs} ms`}`, {
      status,
      ...(retryAfterMs !== undefined && { waitMs: retryAfterMs }),
    });
    this.credentialRejected = status === 401;
  }
}

/** The wait a 429 asks for, from the given header (seconds, or a Unix time), or the fallback. */
export function waitFrom(headers: Headers, now: number, fallbackMs: number): number {
  const reset = Number(headers.get("ratelimit-reset") ?? headers.get("retry-after"));
  if (!Number.isFinite(reset) || reset <= 0) return fallbackMs;
  return reset > 1_000_000_000 ? Math.max(0, reset * 1000 - now) : reset * 1000;
}

export async function call<T>(h: NewsletterHttp, path: string, o: { method?: string; json?: unknown; now?: () => number; rateLimitWaitMs: number }): Promise<{ status: number; body: T }> {
  const res = await h.fetch(`${h.baseUrl}${path}`, {
    method: o.method ?? "GET",
    headers: { accept: "application/json", ...(o.json !== undefined && { "content-type": "application/json" }), ...h.headers },
    ...(o.json !== undefined && { body: JSON.stringify(o.json) }),
    signal: AbortSignal.timeout(h.timeoutMs),
  });
  if (res.status === 429) throw new NewsletterHttpError(h.tool, 429, waitFrom(res.headers, (o.now ?? Date.now)(), o.rateLimitWaitMs));
  if (!res.ok) throw new NewsletterHttpError(h.tool, res.status);
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

/** The key of an api_key connection, or an error that names only the tool. */
export function keyOf(tool: string, c: { key: string } | object | null): string {
  const key = c && "key" in c && typeof c.key === "string" ? c.key.trim() : "";
  if (!key) throw new PluginError("not_connected", `${tool} is not connected: add its API key in Credentials`);
  return key;
}
