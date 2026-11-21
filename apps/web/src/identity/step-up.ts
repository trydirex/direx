// SPDX-License-Identifier: AGPL-3.0-only
// Role changes and removals, which need a sign-in in the last 10 minutes. When the API answers
// step_up_required, Members shows the sign-in and the person makes the change again: nothing keeps
// it to run by itself afterwards (ADR 0037 rule 005).
import type { components } from "../api/schema";
import { api } from "../client";

type Role = components["schemas"]["Role"];
/** A role change, or a removal when `role` is null. */
export type Change = { workspaceId: string; userId: string; role: Role | null };


/** Runs the change; returns the API's error code, or null when it worked. */
export async function applyChange(c: Change): Promise<string | null> {
  const params = { path: { workspaceId: c.workspaceId, userId: c.userId } };
  const { error } = c.role
    ? await api.PATCH("/api/w/{workspaceId}/members/{userId}", { params, body: { role: c.role } })
    : await api.DELETE("/api/w/{workspaceId}/members/{userId}", { params });
  return error ? error.error : null;
}
