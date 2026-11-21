// SPDX-License-Identifier: AGPL-3.0-only
// Adding people from a pasted list, one result per row. CSV values are stored as data and never
// reach a template run. Removing someone keeps their row, with a status, and cancels what hasn't gone.
import type { Items } from "../../items";
import { sentTo } from "../../ledger";
import { BASES, ENTITY_TYPES, OPTED_OUT, whyNot, type Basis, type Confidence, type EntityType, type Outreach } from "../../outreach";
import { emailsOfGroup, normaliseKey, personIdWithEmail } from "../../people";
import { activeActions, addRole, insertOutcome, joinCampaign, lastSentAt, liveElsewhere, liveOutcomes, markConflict, peoplePage, peopleWithRole, personRow, readCampaign, readOutcome, requireApproved, inWorkspace, senderCountryOf, setPersonStatus, type OutcomeKind } from "../adapters/repo";
import { mailboxDay, timeZoneOf } from "../../schedule";
import { CONFLICT_KIND } from "./coordination";
import { parseCsv, type CsvRow } from "../domain/csv";
import { MAX_EVIDENCE, readRow, type PersonRow, type RowRefusal } from "../domain/rows";

/** The most people one call takes, by CSV or by rows. A caller with more splits them into calls of this size. */
export const MAX_ROWS = 1000;
const PAGE = 100;

export type RowResult = { row: number } & ({ ok: true; personId: string; missing: string[] } | { ok: false; reason: RowRefusal | "wrong_column_count" | "bad_email" });

/** One Person to add without a CSV. A null country adds the Person, left out of drafts with `country` missing. */
export type PersonInput = {
  email: string;
  firstName: string | null;
  company: string | null;
  website: string | null;
  country: string | null;
  basis: Basis;
  evidence: string;
  entityType?: EntityType | undefined;
  /** `inferred` when the country was guessed rather than given. Stated otherwise. */
  confidence?: Confidence | undefined;
};
const VOCAB = { bases: BASES, entityTypes: ENTITY_TYPES };
/**
 * What happened to one input row. `joined` means the address matched a Person the Workspace already had;
 * `conflict` means that Person is also live in another Campaign, so a person decides through the conflict Item.
 * A suppressed or already contacted Person isn't added to the Campaign, and nor is one a person removed from it.
 */
export type PersonResult =
  | { status: "added" | "joined"; personId: string; missing: string[] }
  | { status: "conflict"; personId: string; missing: string[]; conflictItemId: string }
  | { status: "suppressed" | "already_contacted" | "removed"; personId: string }
  | { status: "refused"; reason: RowRefusal | "bad_email" };

/** Why a customer row wasn't added. A row refused for its values names the value. */
export type CustomerSkip = "invalid_email" | "no_opt_in" | "suppressed" | "bad_opt_in_date" | "no_country" | "wrong_column_count" | RowRefusal;
type CustomerRow = { status: "added" | "updated"; personId: string; email: string } | { status: "skipped"; reason: CustomerSkip; email?: string };
const OPTED_IN = new Set(["yes", "true", "1"]);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

// The evidence field holds a summary; the caller keeps the full record, so a long one is cut, not refused.
const summary = (evidence: string) => {
  const s = evidence.trim();
  if (s.length <= MAX_EVIDENCE) return s;
  const cut = s.slice(0, MAX_EVIDENCE - 1);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
};

/** The basis and evidence a Person was first added with somewhere else, by address, as prospecting keeps them. */
export type KeptEligibility = (workspaceId: string, email: string) => Promise<{ basis: string; evidence: string } | null>;

export function campaignPeople({ outreach, items, now, keptEligibility }: { outreach: () => Outreach; items: () => Items; now: () => Date; keptEligibility?: KeptEligibility | undefined }) {
  /**
   * A row that gives the country but not the basis or evidence takes the missing parts from where the
   * Person was first found, so entering a country later doesn't mean typing the rest again.
   */
  async function filled(workspaceId: string, row: PersonRow<Basis, EntityType>, confidence?: Confidence) {
    const { given } = row;
    if (row.eligibility || !given.country || !keptEligibility) return { eligibility: row.eligibility, missing: row.missing, confidence };
    const kept = await keptEligibility(workspaceId, row.email);
    const basis = given.basis ?? (kept && (BASES as readonly string[]).includes(kept.basis) ? (kept.basis as Basis) : null);
    const evidence = given.evidence || kept?.evidence || "";
    if (!basis || !evidence) return { eligibility: row.eligibility, missing: row.missing, confidence };
    // Taken from what was found, not stated by a person, so it says so.
    return { eligibility: { country: given.country, basis, evidence, entityType: given.entityType ?? ("unknown" as EntityType), scope: null, expiresAt: null }, missing: [], confidence: confidence ?? ("inferred" as Confidence) };
  }

  /** The one path every accepted row takes, from a CSV or from rows: the Person, the Campaign, and a conflict if they're live elsewhere. */
  async function addRow(workspaceId: string, campaignId: string, row: PersonRow<Basis, EntityType>, userId: string, given?: Confidence) {
    const { eligibility, missing, confidence } = await filled(workspaceId, row, given);
    const { email, eligibility: _e, missing: _m, given: _g, ...fields } = row;
    const person = eligibility ? await outreach().addPerson(workspaceId, { email, ...eligibility, confidence, userId }) : await outreach().ensurePerson(workspaceId, email);
    if (!person.ok) return person;
    const other = await inWorkspace(workspaceId, async (tx) => {
      const isNew = !(await personRow(tx, campaignId, person.id));
      await joinCampaign(tx, { workspaceId, campaignId, personId: person.id, ...fields, addedBy: userId, at: now() });
      return isNew ? liveElsewhere(tx, campaignId, person.id) : null;
    });
    let conflictItemId: string | null = null;
    if (other) {
      const made = await items().createItem(workspaceId, {
        kind: CONFLICT_KIND,
        payload: { campaignId, personId: person.id, otherCampaignId: other },
        actor: { userId },
        // The group names the Campaign, so a page can link straight to it.
        details: { title: `${email} is already in another campaign`, workArea: "outreach", channel: "email", warnings: [], plannedAt: null, groupKey: `campaign:${campaignId}` },
      });
      if (made.ok) {
        conflictItemId = made.item.id;
        await inWorkspace(workspaceId, (tx) => markConflict(tx, campaignId, person.id, made.item.id));
      }
    }
    return { ok: true, personId: person.id, missing, conflictItemId } as const;
  }

  /** Why a Person found by address isn't added: anyone in their group opted out, or was already sent something. */
  async function leftOut(workspaceId: string, personId: string) {
    if ((await whyNot(workspaceId, [personId], "cold")).get(personId) === OPTED_OUT) return "suppressed" as const;
    const sent = await inWorkspace(workspaceId, async (tx) => {
      for (const e of await emailsOfGroup(tx, personId)) if (await sentTo(tx, e)) return true;
      return false;
    });
    return sent ? ("already_contacted" as const) : null;
  }

  async function addInput(workspaceId: string, campaignId: string, input: PersonInput, userId: string): Promise<PersonResult> {
    const values = { email: input.email, first_name: input.firstName, company: input.company, website: input.website, country: input.country, basis: input.basis, entity_type: input.entityType };
    const read = readRow({ ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, (v ?? "").trim()])), evidence: summary(input.evidence) }, VOCAB);
    if (!read.ok) return { status: "refused", reason: read.reason };
    const key = normaliseKey("email", read.row.email);
    if (!key.ok) return { status: "refused", reason: "bad_email" };
    const known = await inWorkspace(workspaceId, (tx) => personIdWithEmail(tx, key.value));
    const person = await outreach().ensurePerson(workspaceId, read.row.email);
    if (!person.ok) return { status: "refused", reason: person.reason };
    const why = await leftOut(workspaceId, person.id);
    if (why) return { status: why, personId: person.id };
    // Rows come from code, not a person, so they never bring back someone a person took out.
    if ((await inWorkspace(workspaceId, (tx) => personRow(tx, campaignId, person.id)))?.status === "removed") return { status: "removed", personId: person.id };
    const added = await addRow(workspaceId, campaignId, read.row, userId, input.confidence);
    if (!added.ok) return { status: "refused", reason: added.reason };
    if (added.conflictItemId) return { status: "conflict", personId: added.personId, missing: added.missing, conflictItemId: added.conflictItemId };
    return { status: known ? "joined" : "added", personId: added.personId, missing: added.missing };
  }

  /**
   * One row of a customer list. Only a recorded opt-in adds the Person, with basis `consent` and the
   * opt-in as its evidence, and the `customer` role. A consent already recorded and still in force is
   * kept as it is; any other basis is replaced by the opt-in, keeping the record's country and entity type.
   */
  async function customerRow(workspaceId: string, raw: CsvRow, senderCountry: string | null, userId: string): Promise<CustomerRow> {
    if ("bad" in raw) return { status: "skipped", reason: raw.bad };
    const v = raw.values;
    const key = normaliseKey("email", v.email ?? "");
    if (!key.ok) return { status: "skipped", reason: "invalid_email", ...(v.email ? { email: v.email } : {}) };
    const email = key.value;
    if (!OPTED_IN.has((v.opted_in ?? "").toLowerCase())) return { status: "skipped", reason: "no_opt_in", email };
    const on = v.opted_in_on ?? "";
    if (on && !isDate(on)) return { status: "skipped", reason: "bad_opt_in_date", email };
    const read = readRow({ email, first_name: v.name ?? "", company: v.company ?? "", country: v.country ?? "" }, VOCAB);
    if (!read.ok) return { status: "skipped", reason: read.reason, email };
    const person = await outreach().ensurePerson(workspaceId, email);
    if (!person.ok) return { status: "skipped", reason: "invalid_email", email };
    if ((await whyNot(workspaceId, [person.id], "consented_marketing", now())).get(person.id) === OPTED_OUT) return { status: "skipped", reason: "suppressed", email };

    const record = await outreach().person(workspaceId, person.id);
    const inForce = record?.basis === "consent" && (!record.expiresAt || new Date(record.expiresAt) > now());
    if (!inForce) {
      const given = read.row.given.country;
      // A row with no country keeps the one on record, or takes the Workspace's own as a guess that says so.
      const country = given || record?.country || senderCountry;
      if (!country) return { status: "skipped", reason: "no_country", email };
      const confidence: Confidence = given ? "stated" : record?.country ? (record.confidence === "inferred" ? "inferred" : "stated") : "inferred";
      const entityType = ENTITY_TYPES.find((t) => t === record?.entityType);
      const evidence = `Customer import: opted in ${on ? `on ${on}` : "(no date given)"}`;
      const saved = await outreach().addPerson(workspaceId, { email, country, basis: "consent", evidence, entityType, confidence, userId });
      if (!saved.ok) return { status: "skipped", reason: "invalid_email", email };
    }
    const added = await inWorkspace(workspaceId, (tx) => addRole(tx, { workspaceId, personId: person.id, role: "customer", name: read.row.firstName, company: read.row.company, addedBy: userId, at: now() }));
    return { status: added ? "added" : "updated", personId: person.id, email };
  }

  return {
    /** A customer list: who was added, who was already a Customer, and who was left out and why. Re-importing adds no one twice. */
    async importCustomers(workspaceId: string, a: { csv: string; userId: string }) {
      const csv = parseCsv(a.csv);
      if (!csv.ok) return csv;
      if (csv.rows.length > MAX_ROWS) return { ok: false, reason: "too_many_rows", limit: MAX_ROWS } as const;
      const senderCountry = await inWorkspace(workspaceId, senderCountryOf);
      const out = { added: [] as { personId: string; email: string }[], updated: [] as { personId: string; email: string }[], skipped: [] as { row: number; email?: string; reason: CustomerSkip }[] };
      for (const raw of csv.rows) {
        const r = await customerRow(workspaceId, raw, senderCountry, a.userId);
        if (r.status === "skipped") out.skipped.push({ row: raw.row, reason: r.reason, ...(r.email ? { email: r.email } : {}) });
        else out[r.status].push({ personId: r.personId, email: r.email });
      }
      return { ok: true, ...out } as const;
    },

    /** The Workspace's Customers, as their import named them, with the basis on record. */
    async customers(workspaceId: string) {
      const rows = await inWorkspace(workspaceId, (tx) => peopleWithRole(tx, "customer"));
      return rows.map((r) => ({ personId: r.personId, email: r.email, name: r.name, company: r.company, addedAt: r.at.toISOString(), basis: r.basis, evidence: r.evidence, basisRecordedAt: r.recordedAt?.toISOString() ?? null }));
    },

    async addPeople(workspaceId: string, campaignId: string, a: { csv: string; userId: string }) {
      const approved = await inWorkspace(workspaceId, (tx) => requireApproved(tx, campaignId));
      if (!approved.ok) return approved;
      const csv = parseCsv(a.csv);
      if (!csv.ok) return csv;
      if (csv.rows.length > MAX_ROWS) return { ok: false, reason: "too_many_rows", limit: MAX_ROWS } as const;

      const results: RowResult[] = [];
      for (const raw of csv.rows) {
        if ("bad" in raw) {
          results.push({ row: raw.row, ok: false, reason: raw.bad });
          continue;
        }
        const read = readRow(raw.values, VOCAB);
        if (!read.ok) {
          results.push({ row: raw.row, ok: false, reason: read.reason });
          continue;
        }
        const added = await addRow(workspaceId, campaignId, read.row, a.userId);
        results.push(added.ok ? { row: raw.row, ok: true, personId: added.personId, missing: added.missing } : { row: raw.row, ok: false, reason: added.reason });
      }
      return { ok: true, results } as const;
    },

    /**
     * Adds people given as rows, one result per row in the same order; a row never throws. Takes at most
     * MAX_ROWS rows a call, so a caller with more sends them in batches. Unlike the CSV, a Person who opted
     * out, was already sent something or was removed from this Campaign is left out with that reason rather than added.
     */
    async addPeopleRows(workspaceId: string, campaignId: string, rows: readonly PersonInput[], actor: { userId: string }) {
      const approved = await inWorkspace(workspaceId, (tx) => requireApproved(tx, campaignId));
      if (!approved.ok) return approved;
      if (rows.length > MAX_ROWS) return { ok: false, reason: "too_many_rows", limit: MAX_ROWS } as const;
      const results: PersonResult[] = [];
      for (const input of rows) results.push(await addInput(workspaceId, campaignId, input, actor.userId));
      return { ok: true, results } as const;
    },

    // Meetings and deals a person marks on a Campaign Person. A mark is never changed or removed: an undo
    // is a new row that voids it, so the readings built on marks can always be traced back.
    /** `on` is the day it happened, an ISO date no later than today in the Workspace's time zone. */
    async markOutcome(workspaceId: string, campaignId: string, a: { personId: string; kind: OutcomeKind; on: string; userId: string }) {
      // ISO dates compare as strings.
      if (a.on > mailboxDay(now(), await timeZoneOf(workspaceId))) return { ok: false, reason: "future_date" } as const;
      return inWorkspace(workspaceId, async (tx) => {
        if (!(await readCampaign(tx, campaignId))) return { ok: false, reason: "not_found" } as const;
        if (!(await personRow(tx, campaignId, a.personId))) return { ok: false, reason: "not_in_campaign" } as const;
        const mark = (await insertOutcome(tx, { workspaceId, campaignId, personId: a.personId, kind: a.kind, occurredOn: a.on, actorUserId: a.userId, at: now() }))!;
        return { ok: true, outcome: { id: mark.id, kind: a.kind, on: a.on } } as const;
      });
    },

    /** Voids a mark with a new row. An undo row can't be undone; that would bring its mark back unseen. */
    async undoOutcome(workspaceId: string, campaignId: string, a: { markId: string; userId: string }) {
      return inWorkspace(workspaceId, async (tx) => {
        if (!(await readCampaign(tx, campaignId))) return { ok: false, reason: "not_found" } as const;
        const mark = await readOutcome(tx, campaignId, a.markId);
        if (!mark || mark.voids) return { ok: false, reason: "mark_not_found" } as const;
        // One undo per mark; a second, or one racing it, conflicts on voids and writes nothing.
        const undone = await insertOutcome(tx, { workspaceId, campaignId, personId: mark.personId, kind: mark.kind, occurredOn: null, voids: mark.id, actorUserId: a.userId, at: now() });
        return undone ? ({ ok: true } as const) : ({ ok: false, reason: "already_undone" } as const);
      });
    },

    /** One page, each Person saying why they can't be emailed if they can't, and the cursor for the next. */
    async people(workspaceId: string, campaignId: string, cursor?: string) {
      const { rows, page, lastSent, outcomes } = await inWorkspace(workspaceId, async (tx) => {
        const rows = await peoplePage(tx, campaignId, cursor, PAGE + 1);
        const page = rows.slice(0, PAGE);
        const ids = page.map((p) => p.personId);
        return { rows, page, lastSent: await lastSentAt(tx, campaignId, ids), outcomes: await liveOutcomes(tx, campaignId, ids) };
      });
      const blocked = await outreach().whyNot(workspaceId, page.map((p) => p.personId), "cold");
      const records = await outreach().records(workspaceId, page.map((p) => p.personId));
      const conflicts = new Map<string, number>();
      for (const p of page) {
        if (p.conflictItemId) conflicts.set(p.conflictItemId, (await items().view(workspaceId, p.conflictItemId))?.revision ?? 0);
      }
      return {
        people: page.map(({ conflictItemId, ...p }) => ({
          ...p,
          blocked: blocked.get(p.personId) ?? null,
          country: records.get(p.personId)?.country ?? null,
          warnings: records.get(p.personId)?.warnings ?? [],
          lastEmailAt: lastSent.get(p.personId)?.toISOString() ?? null,
          outcomes: outcomes.get(p.personId) ?? [],
          conflict: conflictItemId ? { itemId: conflictItemId, revision: conflicts.get(conflictItemId) ?? 0 } : null })),
        next: rows.length > PAGE ? rows[PAGE - 1]!.personId : null,
      };
    },

    async removePerson(workspaceId: string, campaignId: string, personId: string, userId: string) {
      const links = await inWorkspace(workspaceId, async (tx) => ((await setPersonStatus(tx, campaignId, personId, "removed")) ? activeActions(tx, campaignId, null, personId) : null));
      if (!links) return { ok: false, reason: "not_found" } as const;
      // An email already sent, or whose outcome is unknown, refuses to cancel, and that's the right answer for it.
      for (const link of links) await items().cancel(workspaceId, link.itemId, { userId });
      return { ok: true } as const;
    },
  };
}
