// SPDX-License-Identifier: AGPL-3.0-only
// The daily sweep that writes what Direx counted onto a Campaign's plan Measures, as the system. Only a
// count that moved since the last counted reading is written, so a person's correction stands until then.
import { measureSource, type Plans } from "../../plans";
import { campaignsToCount, inWorkspace, interestedPeople, outcomeCounts, repliedPeople, stepCounts } from "../adapters/repo";
import { nextReading, tally } from "../domain/counts";

export function campaignReadings(d: { plans: Pick<Plans, "plan" | "recordReading">; now: () => Date }) {
  async function count(workspaceId: string, campaignId: string, planId: string) {
    const measures = (await d.plans.plan(workspaceId, planId))?.tracking?.measures ?? [];
    // Null where there is nothing to count from yet: no email sent, or no mark of that kind ever made.
    const counts = await inWorkspace(workspaceId, async (tx) => {
      const sent = (await stepCounts(tx, campaignId)).some((c) => c.state === "sent" && c.n > 0);
      const marks = new Map((await outcomeCounts(tx, campaignId)).map((o) => [o.kind, o.people]));
      return {
        replies: sent ? tally(await repliedPeople(tx, campaignId)).people : null,
        interested_replies: sent ? tally(await interestedPeople(tx, campaignId)).people : null,
        meetings: marks.get("meeting") ?? null,
        deals: marks.get("deal") ?? null,
      };
    });
    const today = d.now().toISOString().slice(0, 10);
    for (const m of measures) {
      const source = measureSource(m);
      if (source === "external") continue;
      // Compared with Direx's own newest reading, never a person's, as tracking() orders them.
      const last = m.readings
        .filter((r) => r.source === "system")
        .sort((a, b) => a.observedOn.localeCompare(b.observedOn) || a.at.getTime() - b.at.getTime())
        .at(-1);
      const n = counts[source];
      const value = nextReading(n ?? 0, n !== null, last?.value ?? null);
      if (value !== null) await d.plans.recordReading(workspaceId, planId, { measureKey: m.key, value, observedOn: today, actor: { system: "campaigns.results" } });
    }
  }

  return {
    /** The sweep: every Campaign still within 30 days of its plan's end. One failing is logged and the rest go on. */
    async countReadings(): Promise<void> {
      for (const c of await campaignsToCount()) {
        try {
          await count(c.workspaceId, c.campaignId, c.planId);
        } catch (e) {
          console.error("campaigns: counting readings failed", c, e);
        }
      }
    },
  };
}
