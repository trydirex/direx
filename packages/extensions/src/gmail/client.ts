// SPDX-License-Identifier: AGPL-3.0-only
// The few Gmail REST calls the plugin makes. A send draws one line: any 4xx is
// Gmail's definite answer, and anything else (5xx, a timeout, a cut connection, a
// garbled 2xx) means the message may have gone out. No message here ever carries the
// token.

import { PluginError } from "@direx/plugin-sdk";
import { reasonOfStatus } from "../newsletter/http";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class SendUnknown extends Error {}
export class GmailError extends PluginError {
  /** Always set: these come from an HTTP answer. */
  declare readonly status: number;
  constructor(status: number, message: string) {
    super(reasonOfStatus(status), message, { status });
  }
}

export type SendAnswer =
  | { ok: true; id: string; threadId?: string }
  | { ok: false; status: number; retryable: boolean; permanent: boolean; detail: string; providerLimit?: "sending_limit" | "abuse" };

const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded"]);

// Only explicit spam or abuse refusals count; generic forbidden and policy errors do not.
const ABUSE_MESSAGE = /\b(?:reject(?:ed|ing) as (?:spam|abuse)|likely unsolicited (?:e?mail)|unusual rate of unsolicited (?:e?mail))\b/i;
type GmailErrorBody = { error?: { message?: string; status?: string; errors?: { reason?: string }[] } };

function classify(status: number, body: GmailErrorBody): SendAnswer & { ok: false } {
  const reasons = (body.error?.errors ?? []).map((e) => e.reason ?? "");
  const detail = `Gmail ${status}: ${body.error?.message ?? "no message"}`.slice(0, 300);
  if (status === 429 || (status === 403 && (reasons.some((r) => RATE_REASONS.has(r)) || body.error?.status === "RESOURCE_EXHAUSTED"))) {
    return { ok: false, status, retryable: true, permanent: false, detail, providerLimit: "sending_limit" };
  }
  if (status === 401) return { ok: false, status, retryable: true, permanent: false, detail };
  if (status === 403) {
    const providerLimit = ABUSE_MESSAGE.test(body.error?.message ?? "") ? "abuse" : undefined;
    return { ok: false, status, retryable: false, permanent: false, detail, providerLimit };
  }
  // 400 and every other 4xx: Gmail will not take this message as it is.
  return { ok: false, status, retryable: false, permanent: true, detail };
}

export type ClientOptions = { baseUrl: string; fetch: typeof fetch; timeoutMs: number };
type Query = Record<string, string | number | boolean | string[] | undefined>;

export function gmailClient(o: ClientOptions) {
  function url(path: string, query: Query = {}): string {
    const u = new URL(`${o.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [v]) u.searchParams.append(k, String(x));
    }
    return u.toString();
  }

  const request = (token: string, method: string, path: string, query?: Query, body?: unknown) =>
    o.fetch(url(path, query), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(o.timeoutMs),
    });

  /** A read: JSON on 2xx, null on 404 when asked, GmailError otherwise. */
  async function read<T>(token: string, path: string, query?: Query, opts: { gone?: boolean } = {}): Promise<T | null> {
    const res = await request(token, "GET", path, query);
    if (res.status === 404 && opts.gone) return null;
    if (!res.ok) throw new GmailError(res.status, `Gmail ${res.status} on ${path.split("/")[1]}`);
    return (await res.json()) as T;
  }

  return {
    async send(token: string, raw: string, threadId?: string): Promise<SendAnswer> {
      let res: Response;
      try {
        res = await request(token, "POST", "/messages/send", undefined, threadId ? { raw, threadId } : { raw });
      } catch (e) {
        throw new SendUnknown(`the send may have reached Gmail: ${(e as Error).name}`);
      }
      if (res.status >= 400 && res.status < 500) {
        return classify(res.status, (await res.json().catch(() => ({}))) as GmailErrorBody);
      }
      if (!res.ok) throw new SendUnknown(`Gmail answered ${res.status}; the send may have gone out`);
      const data = (await res.json().catch(() => null)) as { id?: unknown; threadId?: unknown } | null;
      if (typeof data?.id !== "string" || !data.id) throw new SendUnknown("Gmail's answer to the send has no message id");
      return { ok: true, id: data.id, threadId: typeof data.threadId === "string" ? data.threadId : undefined };
    },
    /** One message, or null when Gmail no longer has it. `fields` limits what Gmail sends back at all. */
    message: (token: string, id: string, format: "minimal" | "metadata" | "full" | "raw", metadataHeaders?: string[], fields?: string) =>
      read<GmailMessage>(token, `/messages/${encodeURIComponent(id)}`, { format, metadataHeaders, fields }, { gone: true }),
    /** Takes labels off one message; null when Gmail no longer has it. Never adds one. */
    async unlabel(token: string, id: string, removeLabelIds: string[]): Promise<{ labelIds?: string[] } | null> {
      const res = await request(token, "POST", `/messages/${encodeURIComponent(id)}/modify`, undefined, { removeLabelIds });
      if (res.status === 404) return null;
      if (!res.ok) throw new GmailError(res.status, `Gmail ${res.status} on modify`);
      return (await res.json()) as { labelIds?: string[] };
    },
    list: (token: string, q: { q?: string; labelIds?: string; includeSpamTrash?: boolean; maxResults: number; pageToken?: string }) =>
      read<{ messages?: { id: string }[]; nextPageToken?: string }>(token, "/messages", q),
    /** One history page, or null when Gmail no longer has the start id. */
    history: (token: string, startHistoryId: string, pageToken?: string) =>
      read<{ history?: HistoryRecord[]; historyId?: string; nextPageToken?: string }>(
        token,
        "/history",
        { startHistoryId, pageToken, historyTypes: ["messageAdded", "labelAdded"], labelId: "INBOX", maxResults: 500 },
        { gone: true },
      ),
    profile: (token: string) => read<{ emailAddress?: string; historyId?: string }>(token, "/profile"),
  };
}

export type GmailClient = ReturnType<typeof gmailClient>;

export type MessagePart = {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: MessagePart[];
};
export type GmailMessage = { id: string; threadId?: string; labelIds?: string[]; snippet?: string; payload?: MessagePart; raw?: string; internalDate?: string };
export type HistoryRecord = {
  id?: string;
  messagesAdded?: { message?: { id?: string } }[];
  labelsAdded?: { message?: { id?: string }; labelIds?: string[] }[];
};

export function headerOf(m: GmailMessage | MessagePart | null | undefined, name: string): string | undefined {
  const headers = (m && "payload" in m ? m.payload?.headers : (m as MessagePart | undefined)?.headers) ?? [];
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}
