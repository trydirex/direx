// SPDX-License-Identifier: AGPL-3.0-only
// What an Admin can change and what anyone in the Workspace can see. Cost is information,
// separate from action credits.
import type { Vault } from "../../credentials/index";
import { utcMonth, withBudget } from "../../ledger/index";
import * as repo from "../adapters/repo";
import { budgetChangeAllowed, DEFAULT_BUDGET_MICROS, type Deployment } from "../domain/budget";
import { PROVIDERS, type Provider } from "../domain/routes-check";

export type SettingsRefusal = "cloud_managed" | "credential_not_usable" | "budget_not_allowed" | "unpriced_not_allowed";

export async function readSettings(deployment: Deployment, workspaceId: string) {
  return (await repo.readSettings(workspaceId)) ?? { monthlyBudgetMicros: DEFAULT_BUDGET_MICROS[deployment], allowUnpriced: false };
}

export async function changeSettings(a: {
  deployment: Deployment;
  workspaceId: string;
  actorUserId: string;
  monthlyBudgetMicros: bigint;
  allowUnpriced: boolean;
  now: Date;
}): Promise<SettingsRefusal | null> {
  if (!budgetChangeAllowed(a.deployment, a.monthlyBudgetMicros)) return "budget_not_allowed";
  if (a.deployment === "cloud" && a.allowUnpriced) return "unpriced_not_allowed";
  const { adapter, adapterModel } = (await repo.readSettings(a.workspaceId)) ?? {};
  await repo.insertRevision(a.workspaceId, { monthlyBudgetMicros: a.monthlyBudgetMicros, allowUnpriced: a.allowUnpriced, adapter, adapterModel }, a.actorUserId, a.now);
  return null;
}

/** On self-host, each provider and the credential it uses. On cloud, the contracted list. */
export async function listProviders(deployment: Deployment, vault: () => Vault, workspaceId: string, cloudAvailable: () => Promise<Set<Provider>>) {
  if (deployment === "cloud") {
    const available = await cloudAvailable();
    return PROVIDERS.filter((p) => p !== "openrouter").map((provider) => ({ provider, connected: available.has(provider), credentialId: null, credentialName: null }));
  }
  const rows = await repo.connections(workspaceId);
  return Promise.all(
    PROVIDERS.map(async (provider) => {
      const row = rows.find((r) => r.provider === provider);
      const found = row ? await vault().find(workspaceId, row.credentialId) : null;
      return { provider, connected: Boolean(found), credentialId: found?.id ?? null, credentialName: found?.name ?? null };
    }),
  );
}

/** Only a Workspace-scoped API key qualifies, so a member leaving stops nothing. */
export async function connect(a: {
  deployment: Deployment;
  vault: () => Vault;
  workspaceId: string;
  provider: Provider;
  credentialId: string;
  actorUserId: string;
  now: Date;
}): Promise<SettingsRefusal | null> {
  if (a.deployment === "cloud") return "cloud_managed";
  const found = await a.vault().find(a.workspaceId, a.credentialId);
  if (!found || found.scope !== "workspace" || found.kind !== "api_key" || found.status !== "active") return "credential_not_usable";
  await repo.setConnection(a.workspaceId, a.provider, a.credentialId, a.actorUserId, a.now);
  return null;
}

export async function disconnect(deployment: Deployment, workspaceId: string, provider: Provider): Promise<SettingsRefusal | null> {
  if (deployment === "cloud") return "cloud_managed";
  await repo.clearConnection(workspaceId, provider);
  return null;
}

export async function usage(deployment: Deployment, workspaceId: string, at: Date) {
  const { start, end, key } = utcMonth(at);
  const { settled, spent } = await withBudget(workspaceId, async (b) => ({ settled: await b.settled("model", at), spent: await b.spent("model", at) }));
  const [{ monthlyBudgetMicros }, incidents, rows] = await Promise.all([
    readSettings(deployment, workspaceId),
    repo.incidents(workspaceId, key),
    repo.usageByPurposeAndModel(workspaceId, start, end),
  ]);
  return { month: key, settledMicros: settled, heldMicros: spent - settled, budgetMicros: monthlyBudgetMicros, incidents, rows };
}

export const recentCalls = repo.recentCalls;
