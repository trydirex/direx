// SPDX-License-Identifier: AGPL-3.0-only
// Step links: whether one step may wait on another's output, checked when a step is set up.
import type { Plans } from "../../plans";
import { ensureStep, inWorkspace, insertOutput, latestOutput, postAccountsOf, postUrlOf, readCampaign, stepsOf, type CampaignsTx, type OutputRow, type StepRow, type StepSetup } from "../adapters/repo";
import type { StepUrls } from "../domain/merge";
import { checkDependency, checkOutputUrl, withUtm, type DependencyRefusal, type LinkedStep } from "../domain/step-links";

export type StepOutput = { stepKey: string; url: string; version: number; source: "person" | "system"; at: Date };

const view = (row: OutputRow): StepOutput => ({ stepKey: row.stepKey, url: row.url, version: row.version, source: row.source as StepOutput["source"], at: row.at });

/** A step's current output row. A post step's chosen post becomes a new version when its link appears or changes. */
export async function syncedOutput(tx: CampaignsTx, a: { workspaceId: string; campaignId: string; stepKey: string; at: Date }): Promise<OutputRow | null> {
  const latest = await latestOutput(tx, a.campaignId, a.stepKey);
  const step = (await stepsOf(tx, a.campaignId)).find((s) => s.stepKey === a.stepKey);
  if (step?.type !== "post" || step.outputConnection === null || step.outputNetworkId === null) return latest;
  const posted = await postUrlOf(tx, { campaignId: a.campaignId, stepKey: a.stepKey, connection: step.outputConnection, networkId: step.outputNetworkId });
  // A post that hasn't published, or whose link isn't a usable https URL, leaves the last version current.
  const checked = posted === null ? null : checkOutputUrl(posted);
  if (!checked?.ok || checked.url === latest?.url) return latest;
  const next = { workspaceId: a.workspaceId, campaignId: a.campaignId, stepKey: a.stepKey, version: (latest?.version ?? 0) + 1, url: checked.url, source: "system", actorSystem: "social_post", at: a.at };
  await insertOutput(tx, next);
  return { ...next, actorUserId: null };
}

/** The URL a step's text may use for the step it waits on, tagged when it asks for UTM; or what it is waiting on. */
export async function stepUrls(
  tx: CampaignsTx,
  a: { workspaceId: string; campaignId: string; step: StepRow; at: Date },
): Promise<{ ok: true; urls: StepUrls; used: OutputRow | null } | { ok: false; reason: "waiting_on_step"; waitingOn: string }> {
  const dependsOn = a.step.dependsOnStepKey;
  // A person chose to go ahead without it: the step's text uses none, and a per-Person draft gets no link line.
  if (dependsOn === null || a.step.dependencyWaivedAt) return { ok: true, urls: {}, used: null };
  const output = await syncedOutput(tx, { workspaceId: a.workspaceId, campaignId: a.campaignId, stepKey: dependsOn, at: a.at });
  if (!output) return { ok: false, reason: "waiting_on_step", waitingOn: dependsOn };
  const url = a.step.utm ? withUtm(output.url, { medium: a.step.type, campaign: a.campaignId, content: a.step.stepKey }) : output.url;
  return { ok: true, urls: { [dependsOn]: url }, used: output };
}

/**
 * A template step's subject and text with the links they may use, for sending it as a Placement
 * content check; null when it isn't a template email step with settled words, or its link is missing.
 */
export function templateStep(workspaceId: string, campaignId: string, stepKey: string, at: Date): Promise<{ subject: string; text: string; urls: StepUrls } | null> {
  return inWorkspace(workspaceId, async (tx) => {
    const step = (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey);
    const t = step?.template as { subject?: unknown; text?: unknown; needsDecision?: unknown[] } | null | undefined;
    if (step?.type !== "email" || step.draftingMode !== "template" || step.cancelledAt || typeof t?.subject !== "string" || typeof t.text !== "string" || t.needsDecision?.length) return null;
    const links = await stepUrls(tx, { workspaceId, campaignId, step, at });
    return links.ok ? { subject: t.subject, text: t.text, urls: links.urls } : null;
  });
}

/** Reading and recording a step's output. A person records a manual step's URL; versions only grow. */
export function stepOutputs({ plans, now, briefApproved }: { plans: Plans; now: () => Date; briefApproved: (workspaceId: string, step: StepRow) => Promise<boolean> }) {
  return {
    async currentOutput(workspaceId: string, campaignId: string, stepKey: string): Promise<StepOutput | null> {
      const row = await inWorkspace(workspaceId, (tx) => syncedOutput(tx, { workspaceId, campaignId, stepKey, at: now() }));
      return row ? view(row) : null;
    },

    async recordOutput(workspaceId: string, campaignId: string, stepKey: string, rawUrl: string, actor: { userId: string }) {
      const checked = checkOutputUrl(rawUrl);
      if (!checked.ok) return { ok: false, reason: "bad_url" } as const;
      const campaign = await inWorkspace(workspaceId, (tx) => readCampaign(tx, campaignId));
      if (!campaign) return { ok: false, reason: "not_found" } as const;
      const plan = await plans.plan(workspaceId, campaign.planId);
      if (!plan?.current?.steps.some((s) => s.key === stepKey)) return { ok: false, reason: "step_not_in_plan" } as const;
      // An SEO brief step's output is the draft a person made from its Brief, so it waits for the approval.
      const before = (await inWorkspace(workspaceId, (tx) => stepsOf(tx, campaignId))).find((s) => s.stepKey === stepKey);
      if (before?.type === "seo_brief" && !(await briefApproved(workspaceId, before))) return { ok: false, reason: "brief_not_approved" } as const;
      return inWorkspace(workspaceId, async (tx) => {
        const at = now();
        await ensureStep(tx, { workspaceId, campaignId, stepKey, now: at });
        const step = (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey);
        if (step?.type !== "manual" && step?.type !== "seo_brief") return { ok: false, reason: "not_manual" } as const;
        const latest = await latestOutput(tx, campaignId, stepKey);
        if (latest?.url === checked.url) return { ok: false, reason: "same_url" } as const;
        const version = (latest?.version ?? 0) + 1;
        await insertOutput(tx, { workspaceId, campaignId, stepKey, version, url: checked.url, source: "person", actorUserId: actor.userId, at });
        return { ok: true, output: { stepKey, url: checked.url, version, source: "person", at } satisfies StepOutput } as const;
      });
    },
  };
}

export type StepLinkRefusal = DependencyRefusal | "has_dependants" | "output_account_not_on_step";

const PRODUCES_OUTPUT = new Set(["manual", "post"]);

/** Why this setup would break a step link, or null. A plan step with no row is a manual step. */
export async function stepLinkRefusal(
  tx: CampaignsTx,
  a: { campaignId: string; stepKey: string; setup: StepSetup; planKeys: readonly string[] },
): Promise<StepLinkRefusal | null> {
  const rows = await stepsOf(tx, a.campaignId);
  const linked: LinkedStep[] = a.planKeys.map((key) => {
    if (key === a.stepKey) return { stepKey: key, type: a.setup.type, dependsOnStepKey: null };
    const row = rows.find((r) => r.stepKey === key);
    return { stepKey: key, type: row?.type ?? "manual", dependsOnStepKey: row?.dependsOnStepKey ?? null };
  });
  if (a.setup.dependsOnStepKey) {
    const dependency = checkDependency(linked, a.stepKey, a.setup.dependsOnStepKey);
    if (!dependency.ok) return dependency.reason;
  }
  // A step others wait on must keep producing an output.
  if (!PRODUCES_OUTPUT.has(a.setup.type) && linked.some((s) => s.dependsOnStepKey === a.stepKey)) return "has_dependants";
  if (a.setup.outputConnection != null) {
    if (a.setup.type !== "post") return "output_account_not_on_step";
    const accounts = await postAccountsOf(tx, a.campaignId, a.stepKey);
    if (!accounts.some((p) => p.connection === a.setup.outputConnection && p.networkId === a.setup.outputNetworkId)) return "output_account_not_on_step";
  }
  return null;
}
