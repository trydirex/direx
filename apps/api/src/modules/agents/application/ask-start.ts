// SPDX-License-Identifier: AGPL-3.0-only
// The contract between Ask and a module that owns work a person may ask for (ADR 0008 rule
// 028). It lives here, not in ask, so an owning module and ask never import each other.
import type { z } from "zod";
import type { RunStatus } from "../domain/states";

/** The work areas a person can name with @ (GLOSSARY, Agent). */
export const AREAS = ["social", "outreach", "sales", "support", "inbox", "seo"] as const;
export type Area = (typeof AREAS)[number];

/** What a start made: an agent run, a clip run, a company read. */
export type WorkRef = { kind: string; id: string };
export type WorkState = "running" | "done" | "failed" | "cancelled";
export type WorkReport = { state: WorkState; itemIds: string[] };

export type AskStart<A = unknown> = {
  id: string;
  /** The agent definition that does the work, shown by its role label. */
  definition: string;
  area: Area | null;
  /** One line for Ask's prompt: what it does and the args it needs. */
  says: string;
  args: z.ZodType<A>;
  /** The permission the screen's own button needs. */
  permission: string;
  /** The button's refusals, from this server's records only: never an outside read. `basis` names the versions it read. */
  check(workspaceId: string, a: A): Promise<{ ok: true; title: string; basis: string } | { ok: false; why: string }>;
  /** The button's own call. `key` is the accepted Item's id, so a retry finds the work it already made. */
  start(workspaceId: string, a: A, by: { userId: string; key: string; tainted: boolean }): Promise<{ ok: true; work: WorkRef } | { ok: false; why: string }>;
  report(workspaceId: string, work: WorkRef): Promise<WorkReport | null>;
};

/** A run's status as the done line says it. Every end but success and a cancel is a failure. */
export function workState(s: RunStatus): WorkState {
  if (s === "succeeded") return "done";
  if (s === "cancelled") return "cancelled";
  if (s === "queued" || s === "running" || s === "waiting") return "running";
  return "failed";
}

/** Lets a module list starts whose args differ: each start parses its own args before using them. */
export const askStart = <A>(s: AskStart<A>): AskStart => s as unknown as AskStart;
