// SPDX-License-Identifier: AGPL-3.0-only
// The standing rule calls. Each change returns the API's error code, or null when it worked.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { messageForCode } from "../api/messages";
import { api } from "../client";

export type Rule = components["schemas"]["StandingRule"];
export type Scope = { campaignId: string; stepKey: string };

const at = (workspaceId: string) => ({ path: { workspaceId } });
const one = (workspaceId: string, id: string) => ({ path: { workspaceId, id } });

export const rulesQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "standing-rules"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/standing-rules", { params: at(workspaceId) }))).rules });

/** How many people and waiting emails a rule on this step would cover. */
export const coverageQuery = (workspaceId: string, s: Scope) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "standing-rules", "coverage", s.campaignId, s.stepKey),
    queryFn: () => call(api.GET("/api/w/{workspaceId}/standing-rules/coverage", { params: { ...at(workspaceId), query: s } })),
  });

export async function grant(workspaceId: string, s: Scope, f: { dailyCap: number; expiresAt?: string }): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/standing-rules", { params: at(workspaceId), body: { ...s, ...f } });
  return error ? error.error : null;
}
/** Whether auto-approve over emails an agent writes may be offered on this step, the approvals so far, and the words to agree to. */
const readOffer = (workspaceId: string, s: Scope) => call(api.GET("/api/w/{workspaceId}/standing-rules/agent-written", { params: { ...at(workspaceId), query: s } }));
export type Offer = Awaited<ReturnType<typeof readOffer>>;
export const agentOfferQuery = (workspaceId: string, s: Scope) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "standing-rules", "agent-written", s.campaignId, s.stepKey), queryFn: () => readOffer(workspaceId, s) });
export async function grantAgentWritten(workspaceId: string, s: Scope, f: { wordingVersion: string; expiresAt?: string }): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/standing-rules", { params: at(workspaceId), body: { mode: "agent_written", acknowledged: true, ...s, ...f } });
  return error ? error.error : null;
}
export async function reconfirm(workspaceId: string, id: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/standing-rules/{id}/reconfirm", { params: one(workspaceId, id) });
  return error ? error.error : null;
}
export async function revoke(workspaceId: string, id: string, reason: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/standing-rules/{id}/revoke", { params: one(workspaceId, id), body: { reason } });
  return error ? error.error : null;
}

const MESSAGES: Record<string, string> = {
  forbidden: "Only people who can set up auto-approve can do this.",
  no_approved_email: "Approve at least one email from this template first, without edits.",
  warned_item: "The emails approved here have warnings, so a rule can't cover them.",
  blind_capability: "This mailbox can't confirm whether an email went out, so a rule can't cover it.",
  tainted_template: "This template came from a run that read outside content, so a rule can't cover it.",
  capability_unavailable: "A rule can't cover this step yet. Check its mailbox.",
  cited_fact_changed: "A fact in this template changed. Update the template, then re-confirm.",
  bad_expiry: "Pick an end date within the next 90 days.",
  wrong_state: "This rule was revoked. Create a new one instead.",
  step_has_rule: "This step already has an active auto-approve rule. Revoke it first.",
  not_found: "That step or rule is gone.",
  two_person_rule: "This workspace needs a second person for every approval, so auto-approve can't send unread emails.",
  not_per_person: "This step uses a template. Auto-approve for unread emails only works on emails written for each person.",
  not_email: "Auto-approve for unread emails only covers email steps.",
  outside_content_off: "Answer yes to the website question on this campaign first.",
  gate_closed: "Direx's safety checks for this drafter haven't passed yet.",
  wording_unsigned: "This isn't available yet.",
  wording_outdated: "The wording on this form changed. Read it again and turn it on once more.",
  too_few_approvals: "Approve more of this step's emails first, without edits.",
};
export const say = (code: string) => messageForCode(code, MESSAGES);

export const STATUS: Record<Rule["status"], string> = { active: "Active", suspended: "Needs review", revoked: "Revoked", expired: "Expired" };
export const mayGrant = (role: string) => role === "owner" || role === "admin";
