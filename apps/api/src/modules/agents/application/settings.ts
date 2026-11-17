// SPDX-License-Identifier: AGPL-3.0-only
// Per Workspace and agent: enabled and run caps. Every change appends a revision with its actor,
// in the same transaction. Cloud limits what a Workspace may raise a cap to.
import type { Deployment } from "../../models/index";
import * as repo from "../adapters/repo";
import { DEFAULT_CAPS } from "../domain/caps";

const CLOUD_MAX_CONCURRENT = 10;
const CLOUD_MAX_DAILY = 1_000;

export type SettingsChange = { enabled?: boolean; maxConcurrentRuns?: number; maxDailyRuns?: number };

export function createSettings(d: { deployment: Deployment; now: () => Date }) {
  return {
    async get(workspaceId: string, agent: string) {
      const row = await repo.inWorkspace(workspaceId, (tx) => repo.settingsFor(tx, agent));
      return {
        enabled: row?.enabled ?? true,
        maxConcurrentRuns: row?.maxConcurrentRuns ?? DEFAULT_CAPS.agentConcurrent,
        maxDailyRuns: row?.maxDailyRuns ?? DEFAULT_CAPS.agentDaily,
        revision: row?.revision ?? 0,
      };
    },

    async change(workspaceId: string, agent: string, change: SettingsChange, actorUserId: string) {
      if (d.deployment === "cloud" && ((change.maxConcurrentRuns ?? 0) > CLOUD_MAX_CONCURRENT || (change.maxDailyRuns ?? 0) > CLOUD_MAX_DAILY)) {
        return { ok: false, reason: "over_cloud_limit" } as const;
      }
      const revision = await repo.inWorkspace(workspaceId, (tx) => repo.saveSettings(tx, workspaceId, agent, change, actorUserId, d.now()));
      return { ok: true, revision } as const;
    },
  };
}
