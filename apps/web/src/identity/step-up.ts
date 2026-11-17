// SPDX-License-Identifier: AGPL-3.0-only
// Role changes and removals need a sign-in from the last 10 minutes. When the API answers
// step_up_required, the change waits in sessionStorage while the person signs in again,
// and runs once when they land back on the Members page.
import type { components } from "../api/schema";
import { api } from "../client";

type Role = components["schemas"]["Role"];
/** A role change, or a removal when `role` is null. */
export type Change = { workspaceId: string; userId: string; role: Role | null };

const KEY = "direx.pendingChange";

/** Runs the change; returns the API's error code, or null when it worked. */
export async function applyChange(c: Change): Promise<string | null> {
  const params = { path: { workspaceId: c.workspaceId, userId: c.userId } };
  const { error } = c.role
    ? await api.PATCH("/api/w/{workspaceId}/members/{userId}", { params, body: { role: c.role } })
    : await api.DELETE("/api/w/{workspaceId}/members/{userId}", { params });
  return error ? error.error : null;
}

export function savePending(c: Change, storage: Storage = sessionStorage) {
  storage.setItem(KEY, JSON.stringify(c));
}

/** The waiting change for this Workspace, removed so it runs at most once. */
export function takePending(workspaceId: string, storage: Storage = sessionStorage): Change | null {
  const raw = storage.getItem(KEY);
  storage.removeItem(KEY);
  const c = raw ? (JSON.parse(raw) as Change) : null;
  return c?.workspaceId === workspaceId ? c : null;
}
