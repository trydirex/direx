// SPDX-License-Identifier: AGPL-3.0-only
// What a campaign email relies on, for its approval to bind: the facts it cites and, when it came from
// one, the template. A fact it doesn't cite is left out, so a typo fix elsewhere holds nothing.
import type { SnapshotEntry } from "../../ledger";
import { latestOutput, stepsOf, type CampaignsTx } from "../adapters/repo";

const TEMPLATE_ID = /^campaign:([^:]+):step:(.+)$/;

export const factEntries = (citations: readonly { factId: string; version: number }[]): SnapshotEntry[] =>
  citations.map((c) => ({ kind: "fact", id: c.factId, version: String(c.version) }));

export const templateEntries = (campaignId: string, stepKey: string, revision: number, citations: readonly { factId: string; version: number }[]): SnapshotEntry[] => [
  { kind: "template", id: `campaign:${campaignId}:step:${stepKey}`, version: String(revision) },
  ...factEntries(citations),
];

/** The output version an email's text was filled from: when that step's URL changes, the approval no longer holds. */
export const stepOutputEntries = (campaignId: string, used: { stepKey: string; version: number } | null): SnapshotEntry[] =>
  used ? [{ kind: "step_output", id: `campaign:${campaignId}:step:${used.stepKey}`, version: String(used.version) }] : [];

/** The ledger's "step_output" lookup: the step's latest output version, read only, or null if it has none. */
export async function stepOutputVersion(tx: CampaignsTx, id: string): Promise<string | null> {
  const m = TEMPLATE_ID.exec(id);
  if (!m) return null;
  const latest = await latestOutput(tx, m[1]!, m[2]!);
  return latest ? String(latest.version) : null;
}

/** The ledger's "template" lookup: the step's live revision, or null once it is gone. */
export async function templateVersion(tx: CampaignsTx, id: string): Promise<string | null> {
  const m = TEMPLATE_ID.exec(id);
  if (!m) return null;
  const step = (await stepsOf(tx, m[1]!)).find((s) => s.stepKey === m[2]);
  return step ? String(step.templateRevision) : null;
}
