// SPDX-License-Identifier: AGPL-3.0-only
// One email to one Person: who may be contacted, then a draft a person approves through Items. The
// footer is part of the approved text, so what goes out is exactly what they read.
import { createHash, randomBytes } from "node:crypto";
import type { DedupeClass } from "@direx/plugin-sdk";
import { storedSpec, touchOf } from "@direx/plugin-sdk/host";
import { credentialLabel, credentialSettings } from "../../credentials";
import type { Items, ItemView, Warning } from "../../items";
import type { Actor, Ledger, SnapshotEntry } from "../../ledger";
import { emailsOfGroup, findOrCreateByEmail, listPeople, normaliseKey, personIdWithEmail, type PersonRow } from "../../people";
import { contactSummaries, countReplies, suppressionReasons, emailForToken, eligibilityOf, inWorkspace, insertToken, readSettings, saveEligibility, readSignal, saveSettings, subscribedAmong, suppress, suppressionDetails, undoReplySuppressions, type OutreachTx } from "../adapters/repo";
import { eligibilityWarnings, notEligible, type Basis, type Confidence, type EntityType } from "../domain/eligibility";
import { isPublicHttps, optOutFooter } from "../domain/footer";
import type { Models } from "../../models/index";
import { fixLinks, recordUses, type TrackingInput } from "../../tracking/index";
import { mailboxHold } from "./header-check";
import { resultLines } from "./results";
import { holdOf, holdResult, holdView } from "./holds";
import { subscriberWarningText } from "../domain/subscribers";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export type SendCapability = {
  id: string;
  dedupe: DedupeClass;
  /** Changes when the plugin's declaration of this capability changes; an approval binds it. */
  version?: string | undefined;
  prepare: (workspaceId: string, input: unknown) => Promise<{ spec: unknown; preview: string }>;
};

/** The provider that sends for this credential; none when it isn't a connected Mailbox. */
export type SendFor = (workspaceId: string, credentialId: string) => SendCapability | undefined | Promise<SendCapability | undefined>;

export type OutreachDeps = {
  items: () => Items;
  send: SendFor;
  baseUrl: () => string;
  readBack?: (workspaceId: string, email: string) => Promise<unknown>;
  /** Without it, an Action held for a missing or expired basis waits for a person to resume it. */
  ledger?: () => Pick<Ledger, "resumeHeldBy" | "heldBy">;
  now?: () => Date;
  /** Writes the sentence behind Home's numbers; without it they show alone. */
  generate?: () => Models["generate"] | undefined;
};
/** Why a Person may be contacted. Fields left out keep the record's defaults. */
export type EligibilityInput = {
  country: string;
  basis: Basis;
  evidence: string;
  entityType?: EntityType | undefined;
  scope?: string | null | undefined;
  expiresAt?: Date | null | undefined;
  confidence?: Confidence | undefined;
};
export type Compose = {
  personId: string;
  credentialId: string;
  touchClass: "cold" | "consented_marketing";
  subject: string;
  text: string;
  plannedAt?: Date | undefined;
  /** A caller with its own idea of "the same email" sets this, so editing the text doesn't make a second one. */
  idempotencyKey?: string | undefined;
  groupKey?: string | undefined;
  groupLabel?: string | undefined;
  warnings?: Warning[] | undefined;
  /** What this email relies on beyond its capability and credential. A revise replaces it. */
  snapshot?: SnapshotEntry[] | undefined;
  /** False keeps it a draft, for an email a person must change before anyone can approve it. */
  submit?: boolean | undefined;
  /** A Campaign step's email: its links become tracked links while the Campaign tracks them. */
  tracking?: TrackingInput | undefined;
};
export type Composed = { ok: true; item: ItemView } | { ok: false; reason: "sender_identity_missing" | "person_not_found" | "credential_not_found" | "mailbox_replies_only" };

/** The answer when someone in the Person's group opted out. */
export const OPTED_OUT = "opted out";

/**
 * Why each of these Persons can't get this class of email, the same answer the floors give at dispatch.
 * It needs nothing but the database, so a module without an outreach instance can ask too.
 */
export const whyNot = (workspaceId: string, personIds: string[], touchClass: string, now: Date = new Date()) =>
  inWorkspace(workspaceId, async (tx) => {
    const records = new Map((await eligibilityOf(tx, personIds)).map((r) => [r.personId, r]));
    const why = new Map<string, string>();
    for (const id of personIds) {
      const reason = (await suppressionReasons(tx, await emailsOfGroup(tx, id))).length
        ? OPTED_OUT
        : (holdResult(await holdOf(tx, workspaceId, id, now), touchClass)?.reason ?? notEligible(touchClass, records.get(id) ?? null, now));
      if (reason) why.set(id, reason);
    }
    return why;
  });

export function createOutreach(deps: OutreachDeps) {
  const now = deps.now ?? (() => new Date());

  /**
   * The exact message a person approves: their text, then the footer with a new unsubscribe token.
   * It reads and asks the Mailbox's plugin, and writes nothing, so no transaction waits on the plugin.
   */
  async function prepare(workspaceId: string, a: Compose) {
    const at = now();
    const token = randomBytes(32).toString("hex");
    const send = await deps.send(workspaceId, a.credentialId);
    if (!send) return { ok: false, reason: "credential_not_found" } as const;
    const found = await inWorkspace(workspaceId, async (tx) => {
      const settings = await readSettings(tx);
      if (!settings?.senderName || !settings.postalAddress) return { ok: false, reason: "sender_identity_missing" } as const;
      const email = (await listPeople(tx, a.personId))[0]?.email;
      if (!email) return { ok: false, reason: "person_not_found" } as const;
      const mailbox = await credentialLabel(tx, a.credentialId);
      if (!mailbox) return { ok: false, reason: "credential_not_found" } as const;
      if ((await mailboxHold(tx, a.credentialId)) === "mailbox_replies_only") return { ok: false, reason: "mailbox_replies_only" } as const;
      // Cold email to someone once on the newsletter list says so, and approving it is the yes.
      const subscriber = a.touchClass === "cold" && (await subscribedAmong(tx, await emailsOfGroup(tx, a.personId))).length > 0;
      return { ok: true, email, subscriber, senderName: settings.senderName, postalAddress: settings.postalAddress } as const;
    });
    if (!found.ok) return found;
    const warnings = [...(a.warnings ?? []).filter((w) => w.code !== "newsletter_subscriber"), ...(found.subscriber ? [{ code: "newsletter_subscriber" as const, text: subscriberWarningText(found.email) }] : [])];

    const base = deps.baseUrl();
    const url = isPublicHttps(base) ? `${base}/api/unsubscribe/${workspaceId}/${token}` : null;
    // Only the person's text carries tracked links; the footer and its unsubscribe link never do.
    const links = a.tracking ? await fixLinks(workspaceId, { ...a.tracking, personId: a.personId, text: a.text, now: at }) : null;
    const text = `${links?.text ?? a.text}\n\n${optOutFooter({ senderName: found.senderName, postalAddress: found.postalAddress, unsubscribeUrl: url, trackedPerRecipient: links?.perRecipient ?? false })}`;
    const { spec } = await send.prepare(workspaceId, { to: [found.email], subject: a.subject, text, ...(url ? { listUnsubscribe: url } : {}) });
    const snapshot: SnapshotEntry[] = [...(a.snapshot ?? []), ...(send.version ? [{ kind: "capability", id: send.id, version: send.version }] : [])];
    return {
      ok: true,
      a,
      send,
      token: { hash: hash(token), email: found.email, at },
      links,
      spec: Object.assign({}, spec, { touch: { personId: a.personId, touchClass: a.touchClass, ...(found.subscriber ? { newsletterSubscriber: true } : {}) } }),
      details: { title: a.subject, workArea: "outreach", channel: "email", plannedAt: a.plannedAt ?? null, warnings, groupKey: a.groupKey, groupLabel: a.groupLabel, snapshot },
    } as const;
  }
  type Prepared = Extract<Awaited<ReturnType<typeof prepare>>, { ok: true }>;

  /**
   * The draft's Action and Item in the caller's transaction, not yet submitted. The unsubscribe token
   * is written only with a new Action: a repeat returns the first one, whose text holds the first token.
   */
  async function composeIn(tx: OutreachTx, workspaceId: string, p: Prepared, actor: Actor) {
    const { a } = p;
    const made = await deps.items().createActionItemIn(tx, workspaceId, {
      idempotencyKey: a.idempotencyKey ?? `email:${hash(JSON.stringify([a.personId, a.credentialId, a.touchClass, a.subject, a.text, a.plannedAt ?? null]))}`,
      capability: p.send.id,
      dedupe: p.send.dedupe,
      spec: p.spec,
      credentialId: a.credentialId,
      actor,
      details: p.details,
    });
    if (made.created) {
      await insertToken(tx, workspaceId, p.token.hash, p.token.email, p.token.at);
      if (p.links) await recordUses(tx, workspaceId, made.item.id, p.links, p.token.at);
    }
    return made;
  }

  /** New text under the same Action, in the caller's transaction. Any approval it had is void. */
  async function reviseIn(tx: OutreachTx, workspaceId: string, itemId: string, p: Prepared, actor: Actor) {
    const r = await deps.items().reviseActionItemIn(tx, workspaceId, itemId, { spec: p.spec, actor, details: p.details });
    if (r.ok) {
      await insertToken(tx, workspaceId, p.token.hash, p.token.email, p.token.at);
      if (p.links) await recordUses(tx, workspaceId, itemId, p.links, p.token.at);
    }
    return r;
  }

  async function ensurePerson(workspaceId: string, email: string) {
    const key = normaliseKey("email", email);
    if (!key.ok) return { ok: false, reason: "bad_email" } as const;
    const found = await inWorkspace(workspaceId, (tx) => personIdWithEmail(tx, key.value));
    if (found) return { ok: true, id: found, existed: true } as const;
    await deps.readBack?.(workspaceId, key.value);
    return { ok: true, ...(await findOrCreateByEmail(workspaceId, key.value)) } as const;
  }

  return {
    ensurePerson,

    /** Replies and opt-outs over the last 7 days, each with the sentence behind it when one holds. */
    results: resultLines({ now, generate: deps.generate }),

    senderName: (workspaceId: string) => inWorkspace(workspaceId, async (tx) => (await readSettings(tx))?.senderName ?? null),

    whyNot,

    async overview(workspaceId: string) {
      return inWorkspace(workspaceId, async (tx) => {
        const settings = await readSettings(tx);
        const people: PersonRow[] = await listPeople(tx);
        const records = new Map((await eligibilityOf(tx, people.map((p) => p.id))).map((r) => [r.personId, r]));
        const suppressed = await suppressionDetails(tx, people.map((p) => p.email));
        // The earliest time each address was seen on any of the Workspace's newsletter lists.
        const since = new Map<string, Date>();
        for (const s of await subscribedAmong(tx, people.map((p) => p.email))) if (!since.has(s.email) || s.firstSeenAt < since.get(s.email)!) since.set(s.email, s.firstSeenAt);
        const senderCountry = settings?.senderCountry ?? null;
        const contact = await contactSummaries(tx, people.map((p) => p.id));
        // ponytail: a few queries per Person; batch by hash if the list grows past a few hundred.
        const holds = new Map<string, ReturnType<typeof holdView>>();
        for (const p of people) holds.set(p.id, holdView(await holdOf(tx, workspaceId, p.id, now())));
        return {
          senderName: settings?.senderName ?? null,
          postalAddress: settings?.postalAddress ?? null,
          senderCountry,
          paused: !!settings?.pausedAt,
          people: people.map((p) => ({
            id: p.id,
            email: p.email,
            ...recordView(records.get(p.id), senderCountry),
            suppressed: suppressed.has(p.email),
            suppressedBecause: suppressed.get(p.email)?.reason ?? null,
            quote: suppressed.get(p.email)?.quote ?? null,
            newsletterSince: since.get(p.email.toLowerCase())?.toISOString() ?? null,
            hold: holds.get(p.id) ?? null,
            name: contact.get(p.id)?.name ?? null,
            company: contact.get(p.id)?.company ?? null,
            campaign: contact.get(p.id)?.campaign ?? null,
            lastEmailAt: contact.get(p.id)?.lastEmailAt?.toISOString() ?? null,
            replied: contact.get(p.id)?.replied ?? false,
          })),
        };
      });
    },

    /** Each Person's recorded country and what the country research suggests checking, for a list of them. */
    records(workspaceId: string, personIds: string[]) {
      return inWorkspace(workspaceId, async (tx) => {
        const senderCountry = (await readSettings(tx))?.senderCountry ?? null;
        const rows = await eligibilityOf(tx, personIds);
        return new Map(rows.map((r) => [r.personId, { country: r.country, warnings: eligibilityWarnings(r, senderCountry) }]));
      });
    },

    /** One Person's record and what the country research suggests checking, or null when none is recorded. */
    person(workspaceId: string, personId: string) {
      return inWorkspace(workspaceId, async (tx) => {
        const [record] = await eligibilityOf(tx, [personId]);
        return record ? recordView(record, (await readSettings(tx))?.senderCountry ?? null) : null;
      });
    },

    saveIdentity(workspaceId: string, a: { senderName: string; postalAddress: string; senderCountry?: string | null | undefined }) {
      return inWorkspace(workspaceId, (tx) => saveSettings(tx, workspaceId, a, now()));
    },

    setPaused(workspaceId: string, paused: boolean, userId: string) {
      const at = now();
      return inWorkspace(workspaceId, (tx) => saveSettings(tx, workspaceId, { pausedAt: paused ? at : null, pausedBy: paused ? userId : null }, at));
    },

    /** Adds a Person, or finds the one with this email, and records why they may be contacted. `existed` says the record replaced one. */
    async addPerson(workspaceId: string, a: EligibilityInput & { email: string; userId: string }) {
      const person = await ensurePerson(workspaceId, a.email);
      if (!person.ok) return person;
      await inWorkspace(workspaceId, (tx) =>
        saveEligibility(tx, {
          workspaceId,
          personId: person.id,
          country: a.country,
          basis: a.basis,
          evidence: a.evidence,
          entityType: a.entityType ?? "unknown",
          scope: a.scope ?? null,
          expiresAt: a.expiresAt ?? null,
          countryConfidence: a.confidence ?? "stated",
          recordedBy: a.userId,
          recordedAt: now(),
        }),
      );
      // A new record may answer why mail to them was held. Every check runs again, so one that still
      // doesn't count holds it again.
      // ponytail: one scan of held Actions per saved Person; batch per import if large lists get slow.
      await deps.ledger?.().resumeHeldBy(workspaceId, "not_eligible", { userId: a.userId }, async (_tx, held) => held.personId === person.id);
      return person;
    },

    /** A person reports an opt-out they received another way, such as a reply. */
    async addSuppression(workspaceId: string, email: string) {
      const key = normaliseKey("email", email);
      if (!key.ok) return false;
      await inWorkspace(workspaceId, (tx) => suppress(tx, workspaceId, key.value, "manual", now()));
      return true;
    },

    /**
     * An Owner's undo of an opt-out read from a reply, across the Person's group, with their reason
     * and the reply's quote kept. Other opt-outs stay, and a Blocked send stays Blocked.
     */
    async undoReplyOptOut(workspaceId: string, personId: string, reason: string, userId: string) {
      const undone = await inWorkspace(workspaceId, async (tx) => {
        const emails = await emailsOfGroup(tx, personId);
        const quote = [...(await suppressionDetails(tx, emails)).values()].find((d) => d.reason === "reply" && d.quote)?.quote ?? null;
        return undoReplySuppressions(tx, emails, userId, reason, quote);
      });
      return undone ? ({ ok: true, undone } as const) : ({ ok: false, reason: "nothing_to_undo" } as const);
    },

    /** The public link in a message. False for anything but a token this Workspace issued. */
    unsubscribe(workspaceId: string, token: string) {
      return inWorkspace(workspaceId, async (tx) => {
        const email = await emailForToken(tx, hash(token));
        if (!email) return false;
        await suppress(tx, workspaceId, email, "unsubscribe", now());
        return true;
      });
    },

    /** The reply a person is asked to judge. Its text is gone once decided, or after 30 days. */
    /** How many replies came in between two times, for the morning brief. */
    replyCount(workspaceId: string, from: Date, to: Date) {
      return inWorkspace(workspaceId, (tx) => countReplies(tx, from, to));
    },

    async reply(workspaceId: string, signalId: string) {
      const s = await inWorkspace(workspaceId, (tx) => readSignal(tx, signalId));
      return s && { senderEmail: s.senderEmail, text: s.text, status: s.status };
    },

    tokenIsValid(workspaceId: string, token: string) {
      return inWorkspace(workspaceId, async (tx) => (await emailForToken(tx, hash(token))) !== null);
    },

    /** Whether a mailbox provider can send from this credential. */
    async canSendFrom(workspaceId: string, credentialId: string) {
      return !!(await deps.send(workspaceId, credentialId));
    },

    /** Writes the draft and sends it for approval. The same request twice gives the same Item. */
    async compose(workspaceId: string, a: Compose, userId: string): Promise<Composed> {
      const draft = await prepare(workspaceId, a);
      if (!draft.ok) return draft;
      const items = deps.items();
      const actor = { userId };
      const r = await inWorkspace(workspaceId, async (tx) => {
        const { item } = await composeIn(tx, workspaceId, draft, actor);
        if (a.submit === false) return { item, announce: false };
        const submitted = await items.submitItemIn(tx, workspaceId, item.id, actor);
        return submitted.ok ? submitted : { item, announce: false };
      });
      if (r.announce) await items.announceSubmitted(workspaceId, r.item.id);
      return { ok: true, item: r.announce ? ((await items.view(workspaceId, r.item.id)) ?? r.item) : r.item };
    },
    prepare,
    composeIn,
    reviseIn,

    /** Sends a draft composed with `submit: false` for approval, once whatever it needs beside it is written. */
    async submit(workspaceId: string, itemId: string, userId: string) {
      const submitted = await deps.items().submitItem(workspaceId, itemId, { userId });
      return submitted.ok ? { ok: true as const, item: submitted.item } : submitted;
    },

    /** New text for an email not yet sent, under the same Action. Any approval it had is void. */
    /**
     * Cold email held because its Person joined the newsletter list after it was approved goes back
     * to Needs approval with the subscriber warning, so it sends only on a second yes. The message is
     * the approved one, word for word, with the same unsubscribe link; only the Touch says so now.
     */
    async askAgainForSubscribers(workspaceId: string): Promise<number> {
      let asked = 0;
      for (const held of (await deps.ledger?.().heldBy(workspaceId, "newsletter_subscriber")) ?? []) {
        const touch = touchOf(held.spec);
        const itemId = await deps.items().itemIdForAction(workspaceId, held.id);
        const item = itemId ? await deps.items().view(workspaceId, itemId) : undefined;
        if (!itemId || !item || !touch) continue;
        const to = storedSpec("email.send", held.spec).to?.[0];
        const who = typeof to === "string" ? to : (to?.address ?? "This Person");
        const warnings = [...item.warnings.filter((w) => w.code !== "newsletter_subscriber"), { code: "newsletter_subscriber" as const, text: subscriberWarningText(who) }];
        const r = await deps.items().reviseActionItem(workspaceId, itemId, { spec: Object.assign({}, held.spec, { touch: { ...touch, newsletterSubscriber: true } }), actor: { system: "outreach" }, details: { warnings } });
        if (r.ok) asked++;
      }
      return asked;
    },

    async revise(workspaceId: string, itemId: string, a: Compose, userId: string) {
      const draft = await prepare(workspaceId, a);
      if (!draft.ok) return draft;
      return inWorkspace(workspaceId, (tx) => reviseIn(tx, workspaceId, itemId, draft, { userId }));
    },
  };
}
export type Outreach = ReturnType<typeof createOutreach>;

type RecordRow = { country: string; basis: string; entityType: string; scope: string | null; expiresAt: Date | null; countryConfidence: string };

function recordView(r: RecordRow | undefined, senderCountry: string | null) {
  return {
    country: r?.country ?? null,
    basis: r?.basis ?? null,
    entityType: r?.entityType ?? null,
    scope: r?.scope ?? null,
    expiresAt: r?.expiresAt?.toISOString() ?? null,
    confidence: r?.countryConfidence ?? null,
    warnings: r ? eligibilityWarnings(r, senderCountry) : [],
  };
}

/** The Mailbox an email goes from, by the name Email and keys shows it under (its address, for a connected
    account), for showing the email as it will arrive. Never its connection key. */
export async function mailFrom(workspaceId: string, credentialId: string) {
  const from = (await inWorkspace(workspaceId, (tx) => credentialSettings(tx, credentialId)))?.name;
  return from ? { kind: "email" as const, from } : null;
}
