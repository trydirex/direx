// SPDX-License-Identifier: AGPL-3.0-only
// The lesson calls the pages make. Each change returns the API's error code, or null when it worked.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";
import type { Field } from "../facts/actions";
import { confirmOnStepUp } from "../api/messages";

export type Lesson = components["schemas"]["Lesson"];

/** The writers a lesson can be for, in the words a person reads. */
export const WRITERS = { recipient_writer: "the email writer", campaign_drafter: "the template writer", social_drafter: "the post writer" } as const;
export type Writer = keyof typeof WRITERS;
export const writerWords = (agent: string) => WRITERS[agent as Writer] ?? "a writer";

const MESSAGES: Record<string, string> = {
  lesson_empty: "Write the sentence first.",
  lesson_too_long: "Keep it to one sentence of up to 300 characters.",
  lesson_budget_full: "This writer's lessons are full. Remove or shorten one first.",
  lesson_check_unevaluated: "Lessons aren't switched on yet: Direx hasn't finished testing the check every lesson goes through.",
  lesson_check_unavailable: "Direx couldn't check that sentence just now. Try again in a moment.",
  lesson_check_refused: "Direx can't keep that one.",
  target_changed: "Someone changed this lesson just now. Reload and try again.",
  step_up_required: "This needs a recent sign-in. Sign in again, then try once more.",
  not_found: "That lesson is gone.",
  fact_slot_filled: "Brand already has a fact there. Change it on the Brand page, or pick another place for this one.",
  forbidden: "Your role doesn't allow that.",
};
const REASONS: Record<string, string> = {
  instructs: "it reads as an order rather than how you work",
  names_person: "it names a person",
  mentions_ai: "it mentions AI or instructions",
  contact_detail: "it carries an address, link or handle",
  off_topic: "it isn't about how you do your marketing",
};
export const sayLesson = (code: string, reasons: readonly string[] = []) =>
  `${MESSAGES[code] ?? "That didn't go through. Try again."}${reasons.length ? ` (${reasons.map((r) => REASONS[r] ?? r).join("; ")})` : ""}`;

type Outcome = { error: string; reasons?: string[] } | null;
const outcome = (error: { error: string; reasons?: string[] } | undefined): Outcome => (error ? { error: confirmOnStepUp(error.error), ...(error.reasons && { reasons: error.reasons }) } : null);
const at = (workspaceId: string) => ({ path: { workspaceId } });
const on = (workspaceId: string, id: string) => ({ path: { workspaceId, id } });

export async function proposeLesson(workspaceId: string, agent: Writer, text: string, sourceRef: string): Promise<Outcome> {
  return outcome((await api.POST("/api/w/{workspaceId}/lessons", { params: at(workspaceId), body: { agent, text, sourceRef } })).error);
}
export const lessonsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "lessons"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/lessons", { params: { ...at(workspaceId), query: {} } }))).lessons });
/** Lessons suggested with "Remember this?" that wait in Needs you for an Owner or Admin. */
export const pendingLessonsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "items", "lessons"),
    queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/items", { params: { ...at(workspaceId), query: { state: "needs_approval", limit: 200 } } }))).items.filter((i) => i.kind === "lesson_proposal"),
  });
export async function listLessons(workspaceId: string): Promise<Lesson[]> {
  return (await api.GET("/api/w/{workspaceId}/lessons", { params: { ...at(workspaceId), query: {} } })).data?.lessons ?? [];
}
export async function retireLesson(workspaceId: string, l: Pick<Lesson, "id" | "version">): Promise<Outcome> {
  return outcome((await api.POST("/api/w/{workspaceId}/lessons/{id}/retire", { params: on(workspaceId, l.id), body: { version: l.version } })).error);
}
export async function rewriteLesson(workspaceId: string, l: Pick<Lesson, "id" | "version">, text: string): Promise<Outcome> {
  return outcome((await api.POST("/api/w/{workspaceId}/lessons/{id}/rewrite", { params: on(workspaceId, l.id), body: { version: l.version, text } })).error);
}
export async function lessonToFact(workspaceId: string, l: Pick<Lesson, "id" | "version">, field: Field, sourceLabel: string): Promise<Outcome> {
  return outcome((await api.POST("/api/w/{workspaceId}/lessons/{id}/to-fact", { params: on(workspaceId, l.id), body: { version: l.version, field, sourceLabel } })).error);
}
