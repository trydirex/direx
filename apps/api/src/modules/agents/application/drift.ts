// SPDX-License-Identifier: AGPL-3.0-only
// The daily drift check (ADR 0008 rule 026): each agent version is compared with the one before it in
// the same Workspace, and when its quality-rejection or citation-failure rate rose past the line, the
// Owners and Admins are told once. The notice holds rates and counts only, never a draft's words.
import { named, workspaceName, type Mailer } from "../../identity/index";
import { driftWorkspaces, inWorkspace, openDriftIncident, versionCounts, type VersionCounts } from "../adapters/repo";
import { crossed, previousOf, type Rate } from "../domain/quality";

type Measure = "rejections" | "citations";
const MEASURES: readonly Measure[] = ["rejections", "citations"];

const rateOf = (v: VersionCounts, m: Measure): Rate => ({ rate: m === "rejections" ? v.qualityRejections / v.proposals : v.citationRuns / v.runs, runs: v.runs });

// ponytail: agents are defined across modules, so a new one is named from its id until it gets a line here.
const AGENT_NAMES: Record<string, string> = {
  brand_reader: "Brand reader",
  strategy_drafter: "Strategy drafter",
  plan_drafter: "plan drafter",
  campaign_drafter: "Campaign drafter",
  recipient_reader: "website reader",
  recipient_writer: "email drafter",
  social_drafter: "social post drafter",
  campaign_writer: "write-up drafter",
  clip_picker: "clip picker",
  change_classifier: "competitor change sorter",
  comparison_brief: "comparison page drafter",
  counter_post: "competitor post drafter",
  page_brief: "SEO Brief drafter",
  names_reader: "names reader",
  terms_drafter: "search terms drafter",
  ask: "Ask Direx reply writer",
};
const nameOf = (agent: string) => AGENT_NAMES[agent] ?? agent.replaceAll("_", " ");
const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const words = (n: number) => `${n} ${n === 1 ? "word" : "words"}`;

/** The notice for one version and measure. The edit sentence appears only when both versions were measured. */
export function driftNotice(measure: Measure, agent: string, next: VersionCounts, old: VersionCounts): { subject: string; text: string } {
  const name = nameOf(agent);
  const [now, before] = [rateOf(next, measure), rateOf(old, measure)];
  const counts = `(${next.runs} runs since, ${old.runs} before)`;
  const what =
    measure === "rejections"
      ? `${percent(now.rate)} of its drafts broke a writing rule, up from ${percent(before.rate)} before ${counts}.`
      : `${percent(now.rate)} of its runs cited something that didn't check out, up from ${percent(before.rate)} before ${counts}.`;
  let edits = "";
  if (next.editMedian !== null && old.editMedian !== null) {
    const [m, p] = [Math.round(next.editMedian), Math.round(old.editMedian)];
    edits = m > p ? ` People also edited the drafts they approved more: a median of ${words(m)} changed, up from ${p}.` : ` People changed a median of ${words(m)} in the drafts they approved, against ${p} before.`;
  }
  const subject = measure === "rejections" ? `The ${name}'s drafts are refused more often since its last update` : `The ${name} cites things that don't check out more often since its last update`;
  return { subject, text: `Since Direx changed how the ${name} works, ${what}${edits} See AI models in Workspace settings.` };
}

export function createDrift(d: { mailer: Mailer; adminEmails: (workspaceId: string) => Promise<string[]>; now?: () => Date }) {
  const now = d.now ?? (() => new Date());
  const tell = async (workspaceId: string, mail: { subject: string; text: string }) => {
    const sent = named(await workspaceName(workspaceId))(mail);
    for (const to of await d.adminEmails(workspaceId)) await d.mailer({ to, ...sent });
  };

  /** One Workspace: every version with a previous one, both measures; an incident opened here is mailed. */
  async function checkDrift(workspaceId: string): Promise<void> {
    const versions = await inWorkspace(workspaceId, versionCounts);
    for (const v of versions) {
      const prev = previousOf(versions, v);
      if (!prev) continue;
      for (const measure of MEASURES) {
        const [old, next] = [rateOf(prev, measure), rateOf(v, measure)];
        if (!crossed(old, next)) continue;
        const opened = await inWorkspace(workspaceId, (tx) =>
          openDriftIncident(tx, {
            workspaceId,
            agent: v.agent,
            definitionVersion: v.definitionVersion,
            routeHash: v.routeHash,
            measure,
            previousDefinitionVersion: prev.definitionVersion,
            previousRouteHash: prev.routeHash,
            rate: next.rate,
            previousRate: old.rate,
            runs: next.runs,
            previousRuns: old.runs,
            createdAt: now(),
          }),
        );
        // ponytail: the incident is kept when the mail server is down, so that notice is lost, as with budget notices.
        if (opened) await tell(workspaceId, driftNotice(measure, v.agent, v, prev)).catch((e) => console.error("agents: drift notice failed", workspaceId, e));
      }
    }
  }

  return {
    checkDrift,
    /** The daily sweep: one Workspace failing is logged and the rest go on. */
    async driftAll(): Promise<void> {
      for (const workspaceId of await driftWorkspaces()) {
        try {
          await checkDrift(workspaceId);
        } catch (e) {
          console.error("agents: drift check failed", workspaceId, e);
        }
      }
    },
  };
}

export type Drift = ReturnType<typeof createDrift>;
