// SPDX-License-Identifier: AGPL-3.0-only
// The Strategy and plan calls. A draft can be partial, so the API leaves its shape open and the types
// live here. Each change returns the API's error code, or null when it worked.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";
import { statusLabel, type RunDetail } from "../agents/actions";
import { messageForCode } from "../api/messages";
import { ITEM_MESSAGES } from "../items/actions";

type S = components["schemas"];
export type Strategy = S["Strategy"];
export type Plan = S["Plan"];
export type PlanSummary = S["PlanSummary"];
export type ListedPlan = S["ListedPlan"];

export type Basis = { kind: "fact"; factId: string; version: number } | { kind: "source"; label: string; url?: string } | { kind: "assumption" };
export type Channel = { key: string; label: string; timing: "now" | "later"; reason: string; basis: Basis };
export type StrategyBody = { schemaVersion: 1; whoFor: string; personas: { name: string; notes?: string }[]; positioning: string; channels: Channel[]; assumptions: { text: string }[] };
export type Step = { key: string; on: string; channelKey?: string; title: string; template?: { subject: string; text: string; citations: { factId: string; version: number }[] } };
export type MeasureSource = "replies" | "interested_replies" | "meetings" | "deals" | "external";
// No source is a plan from before sources, which reads as `external`: a person enters its readings.
export type Measure = { key: string; label: string; target: string; basis: Basis; source?: MeasureSource };
export type BudgetLine = { label: string; amountCents: number | null; currency: string; billedBy: "direx" | "your_account" };
export type PlanBody = { schemaVersion: 1; goal: string; audience: string; startsOn: string; endsOn: string; steps: Step[]; measures: Measure[]; budget: BudgetLine[]; assumptions: { text: string }[] };
export type Reading = { value: string; observedOn: string; source: "person" | "system"; at?: string };
export type Tracking = { planned: number; done: number; skipped: number; steps: (Step & { status: "open" | "done" | "skipped" })[]; measures: (Measure & { latest: Reading | null; readings?: Reading[] })[] };

const COUNTED_FROM: Record<Exclude<MeasureSource, "external">, string> = { replies: "email replies", interested_replies: "replies labelled interested", meetings: "meetings marked on People", deals: "deals marked on People" };
/** What Direx counts a Measure from, such as "email replies"; null when a person enters its readings. */
export const countedFrom = (source: MeasureSource | undefined) => (source && source !== "external" ? COUNTED_FROM[source] : null);

export const emptyStrategy = (): StrategyBody => ({ schemaVersion: 1, whoFor: "", personas: [], positioning: "", channels: [], assumptions: [] });
export const emptyPlan = (): PlanBody => ({ schemaVersion: 1, goal: "", audience: "", startsOn: "", endsOn: "", steps: [], measures: [], budget: [], assumptions: [] });
/** A stable id for a line, so its progress and readings survive edits. */
export const newKey = () => crypto.randomUUID();
/** A measure against its target as one line, "142 / 200 Signups (71%)", and the share when both are numbers. */
export function measureWords(m: { label: string; target: string; value: string | null }) {
  if (m.value === null) return { text: `${m.label}: target ${m.target}, no reading yet`, value: null, target: null };
  const value = Number(m.value);
  const target = Number(m.target);
  const counted = Number.isFinite(value) && Number.isFinite(target) && target > 0;
  return { text: `${m.value} / ${m.target} ${m.label}${counted ? ` (${Math.round((value / target) * 100)}%)` : ""}`, value: counted ? value : null, target: counted ? target : null };
}

const MESSAGES: Record<string, string> = {
  stale_revision: "Someone changed this while you were editing. Try again.",
  incomplete: "This isn't finished yet.",
  no_change: "This is already the current version.",
  no_strategy: "Approve the Strategy first. A plan is built on it.",
  target_changed: "A newer version was approved since this one was written. Submit it again.",
  archived: "This plan is archived.",
};
/** After a save someone else beat: what they changed, and that the person's edits are still on screen. */
export const sayRebased = (changed: string[]) => `Someone else saved this draft while you were editing${changed.length ? ` and changed ${changed.join(", ")}` : ""}. Your edits are still here, on top of theirs. Save again to keep them.`;
export const say = (code: string) => (code.startsWith("citation_not_ok") ? "A brand fact this relies on has changed or needs a decision. Update it and submit again." : messageForCode(code, { ...ITEM_MESSAGES, ...MESSAGES }));

const DRAFT_REFUSALS: Record<string, string> = {
  no_route: "Direx can't draft this here yet, so write this one yourself.",
  disabled: "Drafting is turned off for this Workspace, so write this one yourself.",
  no_request: "Say what you want this campaign to do first.",
};
export const sayDraft = (code: string) => DRAFT_REFUSALS[code] ?? say(code);

/** What became of a drafting run, in words. Nothing is decided by a run, so each ends with what's next. */
export function draftOutcome(r: Pick<RunDetail, "status" | "statusReason" | "proposals">): string {
  if (r.status !== "succeeded") return `The draft didn't finish (${statusLabel(r)}). Nothing changed, so you can try again or write it yourself.`;
  if (r.proposals[0]?.rejectionCode === "target_changed") return "You saved changes while Direx was drafting, so your version stayed. Direx's draft is kept on this page for you to use or dismiss.";
  if (r.proposals[0]?.rejectionCode) return "You saved changes while Direx was drafting, so your version stayed.";
  return "Direx drafted this. Read it and change anything. Nothing happens until you submit it and someone approves it.";
}

/** A draft that lost to a person's save, kept for the page it was written for. */
export type DraftOffer = S["DraftOffer"];
export type OfferTarget = { target: "strategy" } | { target: "plan"; id: string } | { target: "step"; id: string; stepKey: string };

/** The kept draft for a target, or null. The API answers 404 when there is none (stale-draft-offer spec). */
export async function getOffer(workspaceId: string, t: OfferTarget): Promise<DraftOffer | null> {
  const { data } = await api.GET("/api/w/{workspaceId}/drafts/offer", { params: { path: { workspaceId }, query: t } });
  return data ?? null;
}
export const offerQuery = (workspaceId: string, t: OfferTarget) => queryOptions({ queryKey: inWorkspace(workspaceId, "drafts", "offer", t), queryFn: () => getOffer(workspaceId, t) });

const offerAt = (workspaceId: string, o: DraftOffer) => ({ path: { workspaceId, runId: o.runId, outputKey: o.outputKey } });

/** Makes the kept draft the draft, against the revision on screen. Returns the error code, or null. */
export async function takeOffer(workspaceId: string, o: DraftOffer, revision: number): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/drafts/offer/{runId}/{outputKey}/use", { params: offerAt(workspaceId, o), body: { revision } });
  return error ? error.error : null;
}

export async function dismissOffer(workspaceId: string, o: DraftOffer): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/drafts/offer/{runId}/{outputKey}/dismiss", { params: offerAt(workspaceId, o) });
  return error ? error.error : null;
}

const WORDS: Record<string, string> = {
  channels_now_out_of_range: "1 to 3 channels for now",
  plan_dates_out_of_range: "dates up to 45 days apart, ending after they start",
  step_outside_plan: "a step inside the plan's dates",
  duplicate_key: "no repeated lines",
};
/** What a draft still needs, named as the editor labels its fields (`labels`, by the path's first part), each once. */
export const missingWords = (m: { path: string; message: string }[], labels: Partial<Record<string, string>> = {}) => [...new Set(m.map((x) => WORDS[x.message] ?? labels[x.path.split(".")[0]!] ?? x.path))].join(", ");

export const basisLabel = (b: Basis, factValue?: (id: string) => string | undefined) =>
  b.kind === "assumption" ? "assumption" : b.kind === "source" ? `From ${b.label}` : `From Brand: ${factValue?.(b.factId) ?? "a brand fact"}`;

const at = (workspaceId: string) => ({ path: { workspaceId } });
const one = (workspaceId: string, id: string) => ({ path: { workspaceId, id } });

export const strategyQuery = (workspaceId: string) => queryOptions({ queryKey: inWorkspace(workspaceId, "strategy"), queryFn: () => call(api.GET("/api/w/{workspaceId}/strategy", { params: at(workspaceId) })) });
export const plansQuery = (workspaceId: string) => queryOptions({ queryKey: inWorkspace(workspaceId, "plans"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/plans", { params: at(workspaceId) }))).plans });
export const planQuery = (workspaceId: string, id: string) => queryOptions({ queryKey: inWorkspace(workspaceId, "plans", id), queryFn: () => call(api.GET("/api/w/{workspaceId}/plans/{id}", { params: one(workspaceId, id) })) });

export async function getStrategy(workspaceId: string): Promise<Strategy | undefined> {
  const { data } = await api.GET("/api/w/{workspaceId}/strategy", { params: at(workspaceId) });
  return data;
}

type Saved = { revision: number; error: null } | { revision?: undefined; error: string };

export async function saveStrategy(workspaceId: string, revision: number, body: StrategyBody): Promise<Saved> {
  const { data, error } = await api.PUT("/api/w/{workspaceId}/strategy/draft", { params: at(workspaceId), body: { revision, body } });
  return data ? { revision: data.revision, error: null } : { error: error!.error };
}

type Submit = { error: string | null; missing?: { path: string; message: string }[] };

export async function submitStrategy(workspaceId: string, revision: number): Promise<Submit> {
  const { error } = await api.POST("/api/w/{workspaceId}/strategy/submit", { params: at(workspaceId), body: { revision } });
  return error ? { error: error.error, missing: error.missing } : { error: null };
}

type Started = { runId: string; error: null } | { runId?: undefined; error: string };

export async function startStrategyDraft(workspaceId: string, request: string): Promise<Started> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/strategy/draft-run", { params: at(workspaceId), body: { request } });
  return data ? { runId: data.runId, error: null } : { error: error!.error };
}

export async function startPlanDraft(workspaceId: string, id: string): Promise<Started> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/plans/{id}/draft-run", { params: one(workspaceId, id) });
  return data ? { runId: data.runId, error: null } : { error: error!.error };
}

export async function listPlans(workspaceId: string): Promise<ListedPlan[]> {
  const { data } = await api.GET("/api/w/{workspaceId}/plans", { params: at(workspaceId) });
  return data?.plans ?? [];
}

/** The longest request the API takes for a new plan. */
export const REQUEST_MAX = 1000;
export async function createPlan(workspaceId: string, a: { title: string; request?: string }): Promise<{ id: string } | { error: string }> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/plans", { params: at(workspaceId), body: a });
  return data ? { id: data.id } : { error: error?.error ?? "failed" };
}
/** Why a new plan was refused. A field the API rejects comes back as "field: what's wrong". */
export function sayCreate(code: string) {
  if (code.startsWith("request")) return `Say what you want in up to ${REQUEST_MAX.toLocaleString("en")} characters.`;
  if (code.startsWith("title")) return "Give the campaign a name of up to 200 characters.";
  return say(code);
}

// Ideas: sentences saved to start a Campaign from later (GLOSSARY "Idea"). Not Items, so never in Needs you.
export type Idea = components["schemas"]["Idea"];
export type StartedIdea = components["schemas"]["StartedIdea"];
export const ideasQuery = (workspaceId: string) => queryOptions({ queryKey: inWorkspace(workspaceId, "ideas"), queryFn: () => call(api.GET("/api/w/{workspaceId}/ideas", { params: at(workspaceId) })) });
export async function addIdea(workspaceId: string, text: string): Promise<boolean> {
  return !(await api.POST("/api/w/{workspaceId}/ideas", { params: at(workspaceId), body: { text } })).error;
}
export async function dismissIdea(workspaceId: string, id: string): Promise<boolean> {
  return !(await api.POST("/api/w/{workspaceId}/ideas/{id}/dismiss", { params: one(workspaceId, id) })).error;
}
/** Links an Idea to the plan just started from it. A failure leaves the Campaign and an open Idea. */
export async function startedIdea(workspaceId: string, id: string, planId: string): Promise<boolean> {
  return !(await api.POST("/api/w/{workspaceId}/ideas/{id}/started", { params: one(workspaceId, id), body: { planId } })).error;
}

export async function getPlan(workspaceId: string, id: string): Promise<Plan | undefined> {
  const { data } = await api.GET("/api/w/{workspaceId}/plans/{id}", { params: one(workspaceId, id) });
  return data;
}

export async function savePlan(workspaceId: string, id: string, revision: number, body: PlanBody): Promise<Saved> {
  const { data, error } = await api.PUT("/api/w/{workspaceId}/plans/{id}/draft", { params: one(workspaceId, id), body: { revision, body } });
  return data ? { revision: data.revision, error: null } : { error: error!.error };
}

export async function submitPlan(workspaceId: string, id: string, revision: number): Promise<Submit> {
  const { error } = await api.POST("/api/w/{workspaceId}/plans/{id}/submit", { params: one(workspaceId, id), body: { revision } });
  return error ? { error: error.error, missing: error.missing } : { error: null };
}

export async function markStep(workspaceId: string, id: string, key: string, status: "open" | "done" | "skipped"): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/plans/{id}/steps/{key}/progress", { params: { path: { workspaceId, id, key } }, body: { status } });
  return error ? error.error : null;
}

export async function addReading(workspaceId: string, id: string, key: string, r: { value: string; observedOn: string }): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/plans/{id}/measures/{key}/readings", { params: { path: { workspaceId, id, key } }, body: r });
  return error ? error.error : null;
}
