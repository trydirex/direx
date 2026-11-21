// SPDX-License-Identifier: AGPL-3.0-only
// The outreach calls. Each change returns the API's error code, or null when it worked.
import { queryOptions } from "@tanstack/react-query";
import { messageForCode } from "../api/messages";
import { call, inWorkspace } from "../api/query";
import type { components } from "../api/schema";
import { api } from "../client";
import { confirmOnStepUp } from "../identity/ConfirmIdentity";


export type Overview = components["schemas"]["Outreach"];
export type Basis = "consent" | "implied" | "legitimate_interest" | "published_address";
export type EntityType = "corporate" | "sole_trader" | "partnership" | "unknown";
export type EligibilityRecord = components["schemas"]["EligibilityRecord"];
type EligibilityWarning = EligibilityRecord["warnings"][number];

const inW = (workspaceId: string) => ({ params: { path: { workspaceId } } });
const code = (r: { error?: { error?: string } }) => (r.error ? confirmOnStepUp(r.error.error ?? "failed") : null);

export const overview = async (workspaceId: string) => (await api.GET("/api/w/{workspaceId}/outreach", inW(workspaceId))).data;
export const outreachQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "outreach"), queryFn: () => call(api.GET("/api/w/{workspaceId}/outreach", inW(workspaceId))) });
/** Connected mail accounts only: model keys and connected social accounts can't send email. */
export async function mailboxes(workspaceId: string) {
  const [credentials, providers] = await Promise.all([api.GET("/api/w/{workspaceId}/credentials", inW(workspaceId)), api.GET("/api/w/{workspaceId}/mailbox-providers", { params: { path: { workspaceId }, query: { purpose: "existing" } } })]);
  const connections = (providers.data?.providers ?? []).map((p) => p.connection);
  return (credentials.data?.credentials ?? []).filter((c) => c.connection !== null && connections.includes(c.connection));
}
export const mailboxesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "outreach", "mailboxes"),
    queryFn: async () => {
      const [credentials, providers] = await Promise.all([call(api.GET("/api/w/{workspaceId}/credentials", inW(workspaceId))), call(api.GET("/api/w/{workspaceId}/mailbox-providers", { params: { path: { workspaceId }, query: { purpose: "existing" } } }))]);
      const connections = providers.providers.map((p) => p.connection);
      return credentials.credentials.filter((c) => c.connection !== null && connections.includes(c.connection)).map(({ id, name }) => ({ id, name }));
    },
  });
export const saveIdentity = async (workspaceId: string, body: { senderName: string; postalAddress: string; senderCountry: string | null }) =>
  code(await api.PUT("/api/w/{workspaceId}/outreach/identity", { ...inW(workspaceId), body }));
export const setPaused = async (workspaceId: string, paused: boolean) => code(await api.PUT("/api/w/{workspaceId}/outreach/pause", { ...inW(workspaceId), body: { paused } }));
export const addPerson = async (
  workspaceId: string,
  body: { email: string; country: string; basis: Basis; evidence: string; entityType?: EntityType; scope?: string | null; expiresAt?: string | null },
) => {
  const r = await api.POST("/api/w/{workspaceId}/outreach/people", { ...inW(workspaceId), body });
  // An email already here is found, not added twice, and its record is replaced.
  return { error: code(r), updated: !!r.data?.updated };
};
/** One Person's record and what to check about it, or null when none is recorded. */
export const eligibility = async (workspaceId: string, personId: string) =>
  (await api.GET("/api/w/{workspaceId}/outreach/people/{personId}", { params: { path: { workspaceId, personId } } })).data ?? null;
export const addSuppression = async (workspaceId: string, email: string) => code(await api.POST("/api/w/{workspaceId}/outreach/suppressions", { ...inW(workspaceId), body: { email } }));
/** An Owner's undo of an opt-out read from a reply. Other opt-outs can't be undone. */
export const undoOptOut = async (workspaceId: string, personId: string, reason: string) =>
  code(await api.POST("/api/w/{workspaceId}/outreach/people/{personId}/undo-opt-out", { params: { path: { workspaceId, personId } }, body: { reason } }));
export const writeEmail = async (workspaceId: string, body: { personId: string; credentialId: string; touchClass: "cold" | "consented_marketing"; subject: string; text: string }) =>
  code(await api.POST("/api/w/{workspaceId}/outreach/emails", { ...inW(workspaceId), body }));

export type OutsideTouch = components["schemas"]["OutsideTouch"];
export type Channel = "call" | "linkedin" | "x" | "email_other" | "other";
const onPerson = (workspaceId: string, personId: string) => ({ params: { path: { workspaceId, personId } } });
/** A call, message or other touch Direx didn't send. Sent ones hold Direx's next cold email 3 days; a received one is a reply. */
export const logTouch = async (workspaceId: string, personId: string, body: { channel: Channel; direction: "outbound" | "inbound"; occurredAt: string }) =>
  code(await api.POST("/api/w/{workspaceId}/outreach/people/{personId}/outside-touches", { ...onPerson(workspaceId, personId), body }));
export const touchesOf = async (workspaceId: string, personId: string) =>
  (await api.GET("/api/w/{workspaceId}/outreach/people/{personId}/outside-touches", onPerson(workspaceId, personId))).data?.touches ?? [];
export const touchesQuery = (workspaceId: string, personId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "outreach", "touches", personId),
    // The touches, and the profiles saved on the Person.
    queryFn: () => call(api.GET("/api/w/{workspaceId}/outreach/people/{personId}/outside-touches", onPerson(workspaceId, personId))),
  });
/** The LinkedIn or X profile a DM step opens for this Person. */
export const addProfile = async (workspaceId: string, personId: string, body: { kind: "linkedin" | "x"; url: string }) =>
  code(await api.POST("/api/w/{workspaceId}/outreach/people/{personId}/profiles", { ...onPerson(workspaceId, personId), body }));
export const removeTouch = async (workspaceId: string, personId: string, id: string) =>
  code(await api.DELETE("/api/w/{workspaceId}/outreach/people/{personId}/outside-touches/{id}", { params: { path: { workspaceId, personId, id } } }));

export type HoldView = components["schemas"]["HoldView"];
/** What holds a Person's cold email, and the running holds an Admin can end. */
export const personHolds = async (workspaceId: string, personId: string) =>
  (await api.GET("/api/w/{workspaceId}/outreach/people/{personId}/holds", onPerson(workspaceId, personId))).data ?? null;
/** "We're talking to them": their campaigns stop, and cold email waits until 90 days after the hold ends. */
export const addHold = async (workspaceId: string, personId: string, reason: string) =>
  code(await api.POST("/api/w/{workspaceId}/outreach/people/{personId}/holds", { ...onPerson(workspaceId, personId), body: { reason } }));
/** Lets a guess go. Any email it held is checked again before it sends. */
export const releaseHold = async (workspaceId: string, personId: string, kind: "inferred" | "company") =>
  code(await api.POST("/api/w/{workspaceId}/outreach/people/{personId}/holds/release", { ...onPerson(workspaceId, personId), body: { kind } }));
export const endHold = async (workspaceId: string, holdId: string) =>
  code(await api.POST("/api/w/{workspaceId}/outreach/holds/{holdId}/end", { params: { path: { workspaceId, holdId } } }));

export type HoldHook = components["schemas"]["HoldHook"]["hook"];
export type HoldHookSecret = components["schemas"]["HoldHookSecret"];
export const holdHook = async (workspaceId: string): Promise<HoldHook> =>
  (await api.GET("/api/w/{workspaceId}/outreach/hold-hook", { params: { path: { workspaceId } } })).data?.hook ?? null;
export const holdHookQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "outreach", "hold-hook"), queryFn: async (): Promise<HoldHook> => (await call(api.GET("/api/w/{workspaceId}/outreach/hold-hook", inW(workspaceId)))).hook });
/** The secret comes back this once; an error is the API's code, such as step_up_required. */
export const makeHoldHook = async (workspaceId: string, hookId?: string): Promise<HoldHookSecret | string> => {
  const r = hookId
    ? await api.POST("/api/w/{workspaceId}/outreach/hold-hook/{hookId}/rotate", { params: { path: { workspaceId, hookId } } })
    : await api.POST("/api/w/{workspaceId}/outreach/hold-hook", { params: { path: { workspaceId } } });
  return r.data ?? code(r) ?? "failed";
};

type Row = Overview["people"][number];
export type Verdict = { kind: "yes" | "not_now" | "stop"; label: string; reason: string | null; group: string | null };

/**
 * Whether Direx can email a Person today, from what the overview holds: an opt-out or bounce, a hold, and the
 * recorded reason. The email limit and address checks aren't in the overview, so they never show here.
 */
export function verdict(x: Row, now = new Date()): Verdict {
  if (x.suppressed)
    return x.suppressedBecause === "hard_bounce"
      ? { kind: "stop", label: "Address doesn't exist", reason: "It bounced, so it's never emailed again", group: "bounced" }
      : { kind: "stop", label: "Asked to stop", reason: x.quote ? `Replied "${x.quote}"` : null, group: null };
  const notNow = (reason: string, group: string): Verdict => ({ kind: "not_now", label: "Not now", reason, group });
  // The hold has ended and nothing runs, but cold email still waits 90 days after it, so this isn't "Talking to them".
  if (x.hold?.reason === "in_conversation" && x.hold.waitUntil) return notNow(`Held until ${x.hold.waitUntil.slice(0, 10)}: cold email waits 90 days after a hold ends`, "held until a date");
  if (x.hold?.reason === "in_conversation") return notNow(`Talking to them${x.hold.detail ? `: ${x.hold.detail}` : ""}`, "talking to them");
  if (x.hold) {
    const why = x.hold.detail === "sent_mail" ? ": you wrote to them in the last 90 days" : x.hold.detail?.startsWith("company:") ? `: you're talking to someone at ${x.hold.detail.slice("company:".length)}` : "";
    return notNow(`May be talking to them${why}. Cold email waits`, "may be talking to them");
  }
  if (!x.country || !x.basis) return notNow("No reason recorded", "no reason recorded");
  if (x.expiresAt && new Date(x.expiresAt) <= now) return notNow(`Reason ended ${x.expiresAt.slice(0, 10)}`, "reason ended");
  return { kind: "yes", label: "Can be emailed", reason: null, group: null };
}

const WORDS: Record<string, string> = {
  in_future: "That time hasn't happened yet.",
  too_late: "It's been more than 10 minutes, so it stays.",
  bad_profile: "That isn't a LinkedIn profile URL or an X handle.",
  not_found: "That's gone.",
  sender_identity_missing: "Save a sender name and postal address first.",
  person_not_found: "That Person is gone.",
  credential_not_found: "That email account is gone.",
  bad_email: "That isn't an email address.",
  no_country: "Choose their country.",
  no_email: "That Person has no email address to hold.",
  exists: "This Workspace already has a webhook. Rotate its secret instead.",
  nothing_to_undo: "Only an opt-out read from a reply can be undone.",
  step_up_required: "Confirm it's you: sign in again, then try once more.",
};
export const say = (error: string) => messageForCode(error, WORDS);

// What country research suggests checking. It never stops a send and is never legal advice.
const WARNING_WORDS: Record<EligibilityWarning, (country: string) => string> = {
  consent_likely_needed: (c) => `cold email to ${c} usually needs consent`,
  entity_needs_consent: () => "UK sole traders and partnerships usually need consent",
  entity_unknown: (c) => `in ${c} the rules depend on the type of business, so add it`,
  not_researched: (c) => `we haven't looked at the rules for ${c}`,
  sender_law: () => "Canadian law covers all email sent from Canada and has no legitimate interest basis",
  country_inferred: () => "the country was guessed from the company",
  sender_country_missing: () => "add your own country under Who is sending",
};
const note = (w: EligibilityWarning, country: string | null) => `To check: ${WARNING_WORDS[w](country ?? "this country")}.`;
/** The sender's missing country is true of every Person at once, so a list says it once, above itself. */
export const SENDER_COUNTRY_NOTE = note("sender_country_missing", null);
export const warningWords = (r: Pick<EligibilityRecord, "warnings" | "country">, inList = false): string[] =>
  r.warnings.filter((w) => !(inList && w === "sender_country_missing")).map((w) => note(w, r.country));

const ENTITY_WORDS: Record<string, string> = { corporate: "company", sole_trader: "sole trader", partnership: "partnership" };
/** The record in one line: country, basis, what kind of business, and when the basis lapses. */
/** Each basis for contacting someone, as a person reads it. */
export const BASIS_WORDS: Record<Basis, string> = {
  published_address: "Published address",
  legitimate_interest: "Legitimate interest",
  implied: "Implied consent",
  consent: "Consent",
};

export function recordWords(r: Pick<EligibilityRecord, "country" | "basis" | "entityType" | "expiresAt">, now = new Date()): string {
  if (!r.country) return "No reason recorded";
  const entity = r.entityType ? ENTITY_WORDS[r.entityType] : undefined;
  const end = r.expiresAt && (new Date(r.expiresAt) <= now ? `ended ${r.expiresAt.slice(0, 10)}, so no cold or marketing email` : `until ${r.expiresAt.slice(0, 10)}`);
  return [r.country, r.basis && (BASIS_WORDS[r.basis as Basis] ?? r.basis), entity, end].filter(Boolean).join(", ");
}

/** Replies people wrote between two times, and how many asked to stop. */
export const replyCountQuery = (workspaceId: string, from: Date, to: Date) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "outreach", "reply-count", from.getTime(), to.getTime()),
    queryFn: () => call(api.GET("/api/w/{workspaceId}/outreach/reply-count", { params: { path: { workspaceId }, query: { from: from.toISOString(), to: to.toISOString() } } })),
  });

/** Replies and opt-outs over the last 7 days, each with the sentence behind it when one holds. Asked once a day. */
export const resultsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "outreach", "results"),
    queryFn: () => call(api.GET("/api/w/{workspaceId}/outreach/results", { params: { path: { workspaceId } } })),
    staleTime: 3_600_000,
  });
