// SPDX-License-Identifier: AGPL-3.0-only
// Trigger intake: webhooks verified by the host before the plugin sees them, polls run
// as a chain of delayed jobs, and one transaction per batch that records new event
// ids, hands them to onEvent and (for polls) moves the cursor. If any part fails the
// whole batch rolls back, so the next delivery brings the same events and none is
// handed off twice. Event data is untrusted input and is never logged. A trigger core reads by
// name has its data parsed through the SDK catalogue's entry before onEvent, in both execution
// modes; a batch with any event that doesn't fit is refused whole, as a malformed poll result is, so
// the cursor never moves past it (ADR 0028 rule 001). Any other trigger's data stays opaque.
import type { Manifest, SkipMail, TriggerData, TriggerDecl, TriggerName } from "@direx/plugin-sdk";
import { triggerEntry } from "@direx/plugin-sdk/host";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { cancelPolls, PollPayload, queuedPolls, sendPoll, trimPolls, workPolls } from "../adapters/poll-queue";
import { advanceCursor, inWorkspace, markNew, readCursor, type CursorRow, type PluginTx } from "../adapters/trigger-repo";
import { header, parseSignatureHeader } from "../domain/signature";
import type { Call, ConnectionCredential } from "./effects";

export type { PluginTx } from "../adapters/trigger-repo";
type EventKey = { workspaceId: string; pluginId: string; credentialId: string | null; eventId: string };
/** An event of a trigger core reads by name: its data was parsed through the catalogue entry. */
export type CatalogueEvent<N extends TriggerName = TriggerName> = { [T in N]: EventKey & { trigger: T; data: TriggerData<T>; custom?: never } }[N];
/** An event of a plugin's own trigger: its data is stored and passed on, never interpreted. */
export type CustomEvent = EventKey & { trigger: string; data: unknown; custom: true };
export type TriggerEvent = CatalogueEvent | CustomEvent;
/** Runs in the transaction that records the event, so a throw undoes both. */
export type OnEvent = (tx: PluginTx, event: TriggerEvent) => Promise<void>;
/** Mail one credential's poll of `trigger` must not read; empty for most. */
export type SkipMailFor = (workspaceId: string, credentialId: string, trigger: string) => Promise<SkipMail[]>;
/**
 * Whether `signature` (64 lowercase hex) is the HMAC-SHA256 of `rawBody` under the signing secret of
 * one webhook trigger in one workspace; null when it has none. The secret never reaches the plugin.
 */
export type VerifyWebhook = (workspaceId: string, pluginId: string, trigger: string, rawBody: Uint8Array, signature: string) => Promise<boolean | null>;
export type WebhookRequest = {
  workspaceId: string;
  pluginId: string;
  trigger: string;
  headers: Record<string, string | undefined>;
  rawBody: Uint8Array;
};
export type WebhookResult =
  | { ok: true; accepted: number }
  | { ok: false; reason: "unknown_trigger" | "no_secret" | "bad_signature" | "bad_payload" };
export type PollOutcome = "handed_off" | "stale" | "failed" | "not_loaded";

const eventList = z.array(z.strictObject({ eventId: z.string().min(1), data: z.unknown() }));
const pollResult = z.strictObject({ events: eventList, cursor: z.string() });

class StaleCursor extends Error {}

type Raw = { eventId: string; data: unknown };
type Parsed = { eventId: string; data: unknown; custom?: true };

/**
 * Each event's data parsed through its trigger's catalogue entry; a plugin's own trigger stays
 * opaque. Throws when any event doesn't fit, naming the trigger and those events' ids, never their data.
 */
function parseEvents(trigger: string, events: readonly Raw[]): Parsed[] {
  const entry = triggerEntry(trigger);
  if (!entry) return events.map((e) => ({ ...e, custom: true }));
  const misfits: string[] = [];
  const parsed = events.map((e) => {
    const d = entry.data.safeParse(e.data);
    if (!d.success) misfits.push(e.eventId);
    return { eventId: e.eventId, data: d.data };
  });
  if (misfits.length) throw new Error(`${trigger} events ${misfits.join(", ")} do not fit the catalogue entry`);
  return parsed;
}

/** Mail a mail.from search found, parsed as email.received events are, so it reaches the same consumers checked. */
export function receivedMail<E extends Raw>(events: readonly E[]): (Omit<E, "data"> & { data: TriggerData<"email.received"> })[] {
  const parsed = parseEvents("email.received", events);
  // Parsed through the email.received entry just above, whose type this is.
  return events.map((e, i) => ({ ...e, data: parsed[i]!.data as TriggerData<"email.received"> }));
}

type Loaded = { manifest: Manifest; call: Call; credential: ConnectionCredential };
export type TriggerDeps = {
  loaded: Map<string, Loaded>;
  onEvent?: OnEvent;
  verifyWebhook?: VerifyWebhook;
  skipMail?: SkipMailFor;
  boss?: PgBoss;
  log: (line: string) => void;
  now: () => Date;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function triggers(deps: TriggerDeps) {
  function need<T>(v: T | undefined, what: string): T {
    if (v === undefined) throw new Error(`plugin triggers need ${what}`);
    return v;
  }

  function find(pluginId: string, trigger: string, source: "webhook" | "poll") {
    const p = deps.loaded.get(pluginId);
    const decl = p?.manifest.capabilities.find((c): c is TriggerDecl => c.kind === "trigger" && c.name === trigger && c.source === source);
    return p && decl ? { ...p, decl } : null;
  }

  async function handOff(
    k: { workspaceId: string; pluginId: string; trigger: string; credentialId: string | null },
    events: Parsed[],
    cursor?: { from: CursorRow; to: string },
  ): Promise<number> {
    const onEvent = need(deps.onEvent, "an onEvent handler");
    return inWorkspace(k.workspaceId, async (tx) => {
      const at = deps.now();
      const fresh = await markNew(tx, k, events.map((e) => e.eventId), at);
      let handed = 0;
      for (const e of events) {
        if (!fresh.delete(e.eventId)) continue;
        // parseEvents parsed the data through this trigger's entry, or marked the trigger custom.
        await onEvent(tx, { ...k, ...e } as TriggerEvent);
        handed++;
      }
      if (cursor && !(await advanceCursor(tx, k, cursor.from, cursor.to, at))) throw new StaleCursor();
      return handed;
    });
  }

  async function pollOnce(p: PollPayload, t: NonNullable<ReturnType<typeof find>>): Promise<PollOutcome> {
    const from = await inWorkspace(p.workspaceId, (tx) => readCursor(tx, p));
    let r: { events: Parsed[]; cursor: string };
    try {
      const credential = await t.credential(p.workspaceId, t.decl, p.credentialId, { consumer: "poll" });
      // Sent only when there is something to skip, so a plugin built before skip existed still polls.
      const skip = p.credentialId && deps.skipMail ? await deps.skipMail(p.workspaceId, p.credentialId, p.trigger) : [];
      const got = pollResult.parse(await t.call(p.workspaceId, "poll", { capability: p.trigger, cursor: from.cursor, credential, ...(skip.length && { skip }) }));
      r = { events: parseEvents(p.trigger, got.events), cursor: got.cursor };
    } catch (e) {
      deps.log(`plugin ${p.pluginId}: poll ${p.trigger} failed: ${message(e)}`);
      return "failed";
    }
    try {
      const key = { workspaceId: p.workspaceId, pluginId: p.pluginId, trigger: p.trigger, credentialId: p.credentialId };
      await handOff(key, r.events, { from, to: r.cursor });
      return "handed_off";
    } catch (e) {
      if (e instanceof StaleCursor) return "stale";
      deps.log(`plugin ${p.pluginId}: events from poll ${p.trigger} were not recorded: ${message(e)}`);
      return "failed";
    }
  }

  const api = {
    /** Whether a loaded plugin declares this webhook trigger. */
    hasWebhook: (pluginId: string, trigger: string): boolean => find(pluginId, trigger, "webhook") !== null,

    /** Verifies, normalizes and hands off one webhook delivery. Its route takes plugin and trigger from the stored webhook. */
    async ingestWebhook(req: WebhookRequest): Promise<WebhookResult> {
      const t = find(req.pluginId, req.trigger, "webhook");
      if (!t || t.decl.source !== "webhook") return { ok: false, reason: "unknown_trigger" };
      const verify = need(deps.verifyWebhook, "a verifyWebhook source");
      const given = parseSignatureHeader(header(req.headers, t.decl.signature.header));
      if (!given) return { ok: false, reason: "bad_signature" };
      const valid = await verify(req.workspaceId, req.pluginId, req.trigger, req.rawBody, given);
      if (valid === null) return { ok: false, reason: "no_secret" };
      if (!valid) return { ok: false, reason: "bad_signature" };
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(req.rawBody));
      } catch {
        return { ok: false, reason: "bad_payload" };
      }
      const r = (await t.call(req.workspaceId, "normalize", { capability: req.trigger, payload })) as { events?: unknown } | null;
      const events = eventList.safeParse(r?.events);
      if (!events.success) throw new Error(`plugin ${req.pluginId} turned a webhook into something that is not a list of events`);
      const key = { workspaceId: req.workspaceId, pluginId: req.pluginId, trigger: req.trigger, credentialId: null };
      return { ok: true, accepted: await handOff(key, parseEvents(req.trigger, events.data)) };
    },

    /** One poll run, then the next one is queued. Called by the queue worker, or directly in tests. */
    async runPoll(input: unknown): Promise<PollOutcome> {
      const p = PollPayload.parse(input);
      const t = find(p.pluginId, p.trigger, "poll");
      if (!t || t.decl.source !== "poll") {
        deps.log(`plugin ${p.pluginId}: poll trigger ${p.trigger} is not loaded, so its polling stops`);
        return "not_loaded";
      }
      const outcome = await pollOnce(p, t);
      // A stale run lost to another run of the same chain, which queues the next one.
      if (outcome !== "stale" && deps.boss && !(await trimPolls(deps.boss, p))) {
        await sendPoll(deps.boss, p, new Date(deps.now().getTime() + t.decl.pollIntervalMs));
      }
      return outcome;
    },

    /** Starts one poll chain per credential, such as one per connected mailbox. */
    async startPolling(workspaceId: string, pluginId: string, trigger: string, credentialId: string | null = null): Promise<void> {
      const boss = need(deps.boss, "pg-boss");
      if (!find(pluginId, trigger, "poll")) throw new Error(`no poll trigger ${pluginId}/${trigger}`);
      const p = { workspaceId, pluginId, trigger, credentialId };
      if (!(await queuedPolls(boss, p)).length) await sendPoll(boss, p, deps.now());
    },

    // ponytail: a run already in flight when this is called still queues one more run;
    // add a stopped flag on the cursor row if that ever matters.
    async stopPolling(workspaceId: string, pluginId: string, trigger: string, credentialId: string | null = null): Promise<void> {
      await cancelPolls(need(deps.boss, "pg-boss"), { workspaceId, pluginId, trigger, credentialId });
    },

    /** Works plugins.poll jobs. */
    work: () => workPolls(need(deps.boss, "pg-boss"), async (p) => void (await api.runPoll(p))),
  };
  return api;
}
