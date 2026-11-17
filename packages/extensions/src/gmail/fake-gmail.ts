// SPDX-License-Identifier: AGPL-3.0-only
// Test only: a small Gmail REST server over real HTTP, with a mailbox, history ids and
// scripted answers. It implements just the calls the plugin makes.

type Header = { name: string; value: string };
type Msg = {
  id: string;
  threadId: string;
  labelIds: string[];
  headers: Header[];
  text?: string;
  html?: string;
  charset?: string;
  textBytes?: Uint8Array;
  attachment?: boolean;
  deliveryStatus?: string;
  snippet: string;
  hidden?: boolean;
  /** The body after the header block, for a message that came in through a send. */
  rawBody?: string;
  /** When Gmail got it, in ms, as Gmail's internalDate. */
  at: number;
};

/** What the next send gets: a status, or a send Gmail takes and then never answers. */
export type SendStep =
  | { status: number; reason?: string; record?: boolean }
  | "hang"
  | "accept_then_hang"
  | "garbled";
type Endpoint = "send" | "get" | "list" | "history" | "profile" | "modify";

const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const never = () => new Promise<Response>(() => {});

const rawBodyOf = (raw: string) => Buffer.from(raw, "base64url").toString("utf8").split("\r\n\r\n").slice(1).join("\r\n\r\n");

/** The message as format=raw gives it: our headers, then the sent body or a plain text one. */
function rawOf(m: Msg): string {
  const head = m.headers.map((h) => `${h.name}: ${h.value}`);
  if (m.rawBody === undefined) head.push("Content-Type: text/plain; charset=UTF-8");
  return b64(`${head.join("\r\n")}\r\n\r\n${m.rawBody ?? m.text ?? ""}`);
}

function parseRaw(raw: string): Header[] {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const head = text.split("\r\n\r\n")[0]!.replace(/\r\n[ \t]/g, " ");
  return head.split("\r\n").map((l) => {
    const i = l.indexOf(":");
    return { name: l.slice(0, i), value: l.slice(i + 1).trim() };
  });
}

export function startFakeGmail(opts: { token?: string; email?: string; pageSize?: number } = {}) {
  const token = opts.token ?? "tok-fake";
  const msgs = new Map<string, Msg>();
  const order: string[] = [];
  const history: { id: number; messagesAdded?: unknown[]; labelsAdded?: unknown[] }[] = [];
  const calls: Record<Endpoint, number> = { send: 0, get: 0, list: 0, history: 0, profile: 0, modify: 0 };
  // Placement checks: any get of one that could carry its body, snippet or subject fails and is recorded.
  const guarded = new Set<string>();
  const bodyReads: string[] = [];
  const modifies: { id: string; add: string[]; remove: string[]; before: string[] }[] = [];
  const sendScript: SendStep[] = [];
  const failures: Partial<Record<Endpoint, { status: number; reason?: string }[]>> = {};
  const sent: { raw: string; headers: Header[]; threadId?: string }[] = [];
  const authHeaders: string[] = [];
  const requests: string[] = [];
  const urls: string[] = [];
  let historyId = 1000;
  let historyFloor = 0;
  let n = 0;

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const error = (status: number, reason = "failed") =>
    json({ error: { code: status, message: `fake ${reason}`, errors: [{ reason }] } }, status);

  function add(m: Omit<Msg, "id" | "snippet" | "at"> & { snippet?: string; at?: number }): string {
    const id = `m${++n}`;
    msgs.set(id, { ...m, id, at: m.at ?? Date.now(), snippet: m.snippet ?? (m.text ?? "").slice(0, 100) });
    order.push(id);
    history.push({ id: ++historyId, messagesAdded: [{ message: { id, labelIds: m.labelIds } }] });
    return id;
  }

  function payload(m: Msg, format: string, wanted: string[]) {
    if (format === "metadata") {
      const w = new Set(wanted.map((x) => x.toLowerCase()));
      return { headers: m.headers.filter((h) => w.has(h.name.toLowerCase())) };
    }
    const leaf = (type: string, body: string | Uint8Array, charset = "UTF-8") => ({
      mimeType: type,
      headers: [{ name: "Content-Type", value: `${type}; charset=${charset}` }],
      body: { data: b64(body) },
    });
    const parts = [];
    if (m.text !== undefined || m.textBytes) parts.push(leaf("text/plain", m.textBytes ?? m.text!, m.charset));
    if (m.html !== undefined) parts.push(leaf("text/html", m.html));
    let body: Record<string, unknown> = parts.length === 1 ? parts[0]! : { mimeType: "multipart/alternative", parts };
    if (m.attachment) {
      body = { mimeType: "multipart/mixed", parts: [body, { mimeType: "text/plain", filename: "a.txt", body: { attachmentId: "att1", size: 9 } }] };
    }
    if (m.deliveryStatus !== undefined) {
      body = { mimeType: "multipart/report", parts: [body, leaf("message/delivery-status", m.deliveryStatus)] };
    }
    return { ...body, headers: [...m.headers, ...((body.headers as Header[]) ?? [])] };
  }

  const newestFirst = (pred: (m: Msg) => boolean) => [...order].reverse().map((id) => msgs.get(id)!).filter(pred);

  function page<T>(items: T[], u: URL): { slice: T[]; next?: string } {
    const size = opts.pageSize ?? Number(u.searchParams.get("maxResults") ?? 100);
    const from = Number(u.searchParams.get("pageToken") ?? 0);
    const next = from + size < items.length ? String(from + size) : undefined;
    return { slice: items.slice(from, from + size), next };
  }

  async function handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const path = u.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
    authHeaders.push(req.headers.get("authorization") ?? "");
    requests.push(`${req.method} ${path}`);
    urls.push(`${req.method} ${path}${u.search}`);
    const ep: Endpoint =
      path === "/messages/send"
        ? "send"
        : path.startsWith("/messages/") && path.endsWith("/modify")
          ? "modify"
          : path.startsWith("/messages/")
            ? "get"
            : path === "/messages"
              ? "list"
              : path === "/history"
                ? "history"
                : "profile";
    calls[ep]++;
    if (req.headers.get("authorization") !== `Bearer ${token}`) return error(401, "authError");
    const fail = failures[ep]?.shift();
    if (fail) return error(fail.status, fail.reason);

    if (ep === "send") {
      const step = sendScript.shift() ?? { status: 200 };
      const body = (await req.json()) as { raw: string; threadId?: string };
      const record = () => {
        // As real Gmail does: any Message-ID the client set is replaced with Gmail's own.
        const headers = [
          ...parseRaw(body.raw).filter((h) => h.name.toLowerCase() !== "message-id"),
          { name: "Message-ID", value: `<gmail-${n + 1}@mail.gmail.com>` },
        ];
        sent.push({ raw: body.raw, headers, threadId: body.threadId });
        // As real Gmail does: mail to the account's own address is one message, in Sent and the inbox.
        const toSelf = headers.find((h) => h.name === "To")?.value.toLowerCase().includes(opts.email ?? "dana@example.com");
        const labelIds = toSelf ? ["SENT", "INBOX", "UNREAD"] : ["SENT"];
        const id = add({ threadId: body.threadId ?? `t${n + 1}`, labelIds, headers, rawBody: rawBodyOf(body.raw) });
        return { id, threadId: msgs.get(id)!.threadId, labelIds };
      };
      if (step === "hang") return never();
      if (step === "accept_then_hang") {
        record();
        return never();
      }
      if (step === "garbled") {
        record();
        return new Response("not json", { status: 200 });
      }
      if (step.status === 200) return json(record());
      if (step.record) record();
      return error(step.status, step.reason);
    }
    if (ep === "modify") {
      const m = msgs.get(decodeURIComponent(path.slice("/messages/".length, -"/modify".length)));
      if (!m) return error(404, "notFound");
      const body = (await req.json()) as { addLabelIds?: string[]; removeLabelIds?: string[] };
      const add = body.addLabelIds ?? [];
      const remove = body.removeLabelIds ?? [];
      modifies.push({ id: m.id, add, remove, before: [...m.labelIds] });
      m.labelIds = [...m.labelIds.filter((l) => !remove.includes(l)), ...add.filter((l) => !m.labelIds.includes(l))];
      return json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
    }
    if (ep === "get") {
      const m = msgs.get(decodeURIComponent(path.slice("/messages/".length)));
      if (!m) return error(404, "notFound");
      const format = u.searchParams.get("format") ?? "full";
      const fields = u.searchParams.get("fields")?.split(",");
      if (guarded.has(m.id)) {
        const headers = u.searchParams.getAll("metadataHeaders").map((h) => h.toLowerCase());
        const labelsOnly = format === "minimal" || (format === "metadata" && headers.every((h) => h === "message-id"));
        if (!labelsOnly || !fields || fields.includes("snippet")) {
          bodyReads.push(`${m.id}:${format}`);
          return error(403, "placementCheckBodyRead");
        }
      }
      if (format === "raw") return json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, raw: rawOf(m) });
      const full: Record<string, unknown> = { id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: m.snippet, internalDate: String(m.at) };
      if (format !== "minimal") full.payload = payload(m, format, u.searchParams.getAll("metadataHeaders"));
      if (!fields) return json(full);
      const kept: Record<string, unknown> = {};
      for (const f of fields) {
        if (f === "payload/headers") kept.payload = { headers: (full.payload as { headers?: Header[] } | undefined)?.headers ?? [] };
        else if (f in full) kept[f] = full[f];
      }
      return json(kept);
    }
    if (ep === "list") {
      const q = u.searchParams.get("q");
      const label = u.searchParams.get("labelIds");
      let found: Msg[];
      if (label === "SENT" && !q) found = newestFirst((m) => m.labelIds.includes("SENT"));
      else if (q && /^in:sent after:\d+$/.test(q)) {
        const after = Number(q.slice("in:sent after:".length)) * 1000;
        found = newestFirst((m) => m.labelIds.includes("SENT") && m.at > after).sort((x, y) => y.at - x.at);
      }
      else if (q === "in:inbox -from:me newer_than:7d") {
        found = newestFirst((m) => !m.hidden && m.labelIds.includes("INBOX") && !m.labelIds.includes("SENT"));
      } else if (q && /^from:\S+ newer_than:7d -in:sent -in:drafts$/.test(q)) {
        const from = q.split(" ")[0]!.slice("from:".length).toLowerCase();
        found = newestFirst((m) => !m.hidden && !m.labelIds.includes("SENT") && !!m.headers.find((h) => h.name === "From")?.value.toLowerCase().includes(from));
      } else if (q && /^from:\S+ subject:"[^"]*"( -subject:"[^"]*")? after:\d+ before:\d+$/.test(q)) {
        // A Placement check search: sender, subject phrase, not the other tag, inside the window.
        const [, from, phrase, , not, after, before] = /^from:(\S+) subject:"([^"]*)"( -subject:"([^"]*)")? after:(\d+) before:(\d+)$/.exec(q)!;
        const anywhere = u.searchParams.get("includeSpamTrash") === "true";
        found = newestFirst((m) => {
          const subject = (m.headers.find((h) => h.name === "Subject")?.value ?? "").toLowerCase();
          return (
            !m.labelIds.includes("SENT") &&
            (anywhere || !m.labelIds.some((l) => l === "SPAM" || l === "TRASH")) &&
            !!m.headers.find((h) => h.name === "From")?.value.toLowerCase().includes(from!.toLowerCase()) &&
            subject.includes(phrase!.toLowerCase()) &&
            !(not && subject.includes(not.toLowerCase())) &&
            m.at >= Number(after) * 1000 &&
            m.at < Number(before) * 1000
          );
        });
      } else if (q && /^rfc822msgid:\S+$/.test(q)) {
        const id = `<${q.slice("rfc822msgid:".length)}>`;
        found = newestFirst((m) => m.headers.find((h) => h.name === "Message-ID")?.value === id);
      } else if (q && /^in:anywhere \{in:inbox in:spam\} subject:"[^"]*"$/.test(q)) {
        const subject = q.slice(q.indexOf('subject:"') + 9, -1);
        found = newestFirst((m) => (m.labelIds.includes("INBOX") || m.labelIds.includes("SPAM")) && m.headers.find((h) => h.name === "Subject")?.value === subject);
      } else return error(400, "badQuery");
      const p = page(found, u);
      return json(p.slice.length ? { messages: p.slice.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: p.next } : {});
    }
    if (ep === "history") {
      const start = Number(u.searchParams.get("startHistoryId"));
      if (start < historyFloor) return error(404, "notFound");
      const p = page(
        history.filter((r) => r.id > start),
        u,
      );
      return json({ history: p.slice.map((r) => ({ ...r, id: String(r.id) })), historyId: String(historyId), nextPageToken: p.next });
    }
    return json({ emailAddress: opts.email ?? "dana@example.com", historyId: String(historyId) });
  }

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });

  return {
    url: `http://127.0.0.1:${server.port}/gmail/v1/users/me`,
    token,
    calls,
    sent,
    authHeaders,
    /** Every request as "METHOD /path", to show a read changed nothing. */
    requests,
    /** Every request with its query string, to show what a read asked Gmail for. */
    urls,
    sendScript,
    /** Every get of a guarded Placement check that asked for more than its labels and Message-ID. */
    bodyReads,
    /** Every label change, with the labels the message had before it. */
    modifies,
    /** Marks a message as a Placement check: a get of its body, snippet or subject fails from now on. */
    guard: (id: string) => void guarded.add(id),
    labelsOf: (id: string) => [...msgs.get(id)!.labelIds],
    failNext(ep: Endpoint, status: number, reason?: string) {
      (failures[ep] ??= []).push({ status, reason });
    },
    /** Puts a message in the inbox, as mail arriving. */
    deliver(m: {
      from: string;
      subject: string;
      text?: string;
      html?: string;
      charset?: string;
      textBytes?: Uint8Array;
      attachment?: boolean;
      deliveryStatus?: string;
      labelIds?: string[];
      headers?: Record<string, string>;
      snippet?: string;
      /** When it arrived, in ms; it also sets the Date header. */
      at?: number;
    }): string {
      const headers: Header[] = [
        { name: "From", value: m.from },
        { name: "To", value: opts.email ?? "dana@example.com" },
        { name: "Subject", value: m.subject },
        { name: "Date", value: m.at === undefined ? "Mon, 2 Nov 2026 09:00:00 +0000" : new Date(m.at).toUTCString() },
        { name: "Message-ID", value: `<in-${n + 1}@example.com>` },
        ...Object.entries(m.headers ?? {}).map(([name, value]) => ({ name, value })),
      ];
      return add({
        threadId: `t${n + 1}`,
        labelIds: m.labelIds ?? ["INBOX", "UNREAD"],
        headers,
        text: m.text,
        html: m.html,
        charset: m.charset,
        textBytes: m.textBytes,
        attachment: m.attachment,
        deliveryStatus: m.deliveryStatus,
        snippet: m.snippet,
        at: m.at,
      });
    },
    /** A message the account sent itself, outside Direx, at a given time. */
    sentMail(m: { to: string; cc?: string; at: number; headers?: Record<string, string>; text?: string }): string {
      const headers: Header[] = [
        { name: "From", value: opts.email ?? "dana@example.com" },
        { name: "To", value: m.to },
        ...(m.cc ? [{ name: "Cc", value: m.cc }] : []),
        { name: "Subject", value: "a private subject" },
        { name: "Message-ID", value: `<out-${n + 1}@mail.gmail.com>` },
        ...Object.entries(m.headers ?? {}).map(([name, value]) => ({ name, value })),
      ];
      return add({ threadId: `t${n + 1}`, labelIds: ["SENT"], headers, text: m.text ?? "a private body", at: m.at });
    },
    /** Moves a message into the inbox: a labelsAdded history record. */
    moveToInbox(id: string) {
      const m = msgs.get(id)!;
      m.labelIds = [...m.labelIds.filter((l) => l !== "INBOX"), "INBOX"];
      history.push({ id: ++historyId, labelsAdded: [{ message: { id }, labelIds: ["INBOX"] }] });
    },
    hideFromSearch(id: string) {
      msgs.get(id)!.hidden = true;
    },
    /** Gmail forgets every history id older than the current one: reading from those gets 404. */
    expireHistory() {
      historyFloor = historyId;
    },
    /** Adds history records that change nothing we read, to make history long. */
    padHistory(count: number) {
      for (let i = 0; i < count; i++) history.push({ id: ++historyId });
    },
    stop: () => server.stop(true),
  };
}

export type FakeGmail = ReturnType<typeof startFakeGmail>;
