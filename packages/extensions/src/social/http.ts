// SPDX-License-Identifier: AGPL-3.0-only
// What every social plugin does the same way: one authorised GET, and what its status means.
import { PluginError, type QueryOutput } from "@direx/plugin-sdk";
import { reasonOfStatus } from "../newsletter/http";

export type SocialHttp = { baseUrl: string; fetch: typeof fetch; timeoutMs: number };

/** Thrown for any answer but a success. The message holds the status only, never a body or token. */
export class SocialHttpError extends PluginError {
  /** Always set: these come from an HTTP answer. */
  declare readonly status: number;
  /** `networkCode` is a network's own error number, which some send with any HTTP status. */
  constructor(
    status: number,
    readonly networkCode?: number,
  ) {
    super(reasonOfStatus(status), `the network answered ${status}${networkCode === undefined ? "" : ` with code ${networkCode}`}`, { status });
  }
}

export async function getJson<T>(h: SocialHttp, path: string, token: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await h.fetch(`${h.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...headers },
    signal: AbortSignal.timeout(h.timeoutMs),
  });
  const body = (await res.json().catch(() => null)) as (T & { error?: { code?: unknown } }) | null;
  const code = typeof body?.error?.code === "number" ? body.error.code : undefined;
  if (!res.ok || code !== undefined) throw new SocialHttpError(res.status, code);
  return body as T;
}

/** `body` holds a network's reply, or null. Each plugin reads only the fields its docs name. */
export type Answer = { status: number; headers: Headers; body: Record<string, unknown> | null };
/** One write. A dropped connection throws, and the caller alone knows what its answer means. */
export async function send(h: SocialHttp, path: string, o: { headers?: Record<string, string>; json?: unknown; form?: Record<string, string>; method?: string }): Promise<Answer> {
  const res = await h.fetch(`${h.baseUrl}${path}`, {
    method: o.method ?? "POST",
    headers: { accept: "application/json", ...(o.json !== undefined && { "content-type": "application/json" }), ...o.headers },
    ...(o.json !== undefined && { body: JSON.stringify(o.json) }),
    ...(o.form && { body: new URLSearchParams(o.form) }),
    signal: AbortSignal.timeout(h.timeoutMs),
  });
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as Answer["body"] };
}

/** Only the network refusing the token asks a person to reconnect. Anything else may pass by itself. */
export async function healthOf(call: () => Promise<unknown>, refusedBy: readonly number[] = [401], refusedCodes: readonly number[] = []): Promise<QueryOutput<"social.health">> {
  try {
    await call();
    return { ok: true };
  } catch (e) {
    const refused = e instanceof SocialHttpError && (refusedBy.includes(e.status) || (e.networkCode !== undefined && refusedCodes.includes(e.networkCode)));
    return { ok: false, reason: refused ? "auth" : "other" };
  }
}

export type SocialPluginOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** How often and how long to wait for a network to process an uploaded video. Tests shorten it. */
  videoWait?: VideoWait;
};
export type VideoWait = { everyMs: number; forMs: number };
/** [DEFAULT] Three minutes leaves the upload and the post inside the five a publish may take. */
export const VIDEO_WAIT: VideoWait = { everyMs: 5_000, forMs: 3 * 60_000 };
export const socialHttp = (o: SocialPluginOptions, baseUrl: string): SocialHttp => ({ baseUrl: o.baseUrl ?? baseUrl, fetch: o.fetch ?? fetch, timeoutMs: o.timeoutMs ?? 20_000 });

/**
 * The two reads every network answers, and publishing and reading its posts where they're built; `posts` declares
 * `social.posts`, which the plugin then answers. CI finds each plugin's `id:` in its manifest.ts, so ids stay literal there.
 */
export const socialManifest = (m: { id: string; connection: string; auth?: "oauth2" | "basic"; hosts: readonly string[]; publish?: { dedupe: "queryable" | "blind"; timeoutMs?: number; media?: "read" }; posts?: boolean }) =>
  ({
    id: m.id,
    apiVersion: 1,
    version: "0.1.0",
    minHostVersion: "0.1.0",
    trust: "first_party",
    connections: [{ key: m.connection, auth: m.auth ?? "oauth2" }],
    egress: { hosts: [...m.hosts] },
    capabilities: [
      { kind: "query", name: "social.identity", connection: m.connection },
      { kind: "query", name: "social.health", connection: m.connection },
      ...(m.posts ? [{ kind: "query", name: "social.posts", connection: m.connection }] : []),
      ...(m.publish ? [{ kind: "effect", name: "social.publish", connection: m.connection, risk: "medium", reachesPerson: false, ...m.publish }] : []),
    ],
  }) as const;

export const tokenOf = (c: { accessToken: string } | object | null): string => {
  if (c && "accessToken" in c) return c.accessToken;
  throw new PluginError("not_connected", "account not connected");
};
