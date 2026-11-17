// SPDX-License-Identifier: AGPL-3.0-only
// Content tests: a Campaign step's real wording, filled with placeholder values, sent as a Placement
// check. To this Workspace's own Mailboxes it needs nothing more; to another Circle member it needs a
// person's yes for that one step, given after seeing the receiving addresses and being told copies
// can be kept. The yes is bound into each such check's approval, so a newer yes or new words hold it.
import { can, type Role } from "../../identity/index";
import type { Resolver, SnapshotEntry } from "../../ledger/index";
import type { Deployment } from "../../models/index";
import { contentTestById, currentContentTest, inWorkspace, insertContentTest, isOwnMailbox, isTemplateStep, newestContentTest, type ContentTestRow, type PlacementTx } from "../adapters/repo";

/** Bumped whenever the words below change; a yes given on older words no longer counts. */
export const CONTENT_TEST_WORDING_VERSION = "2026-11-10";
/** Shown right before the yes, naming every receiving address. */
export const contentTestWording = (receivers: readonly string[]) =>
  [
    "Direx will send this step's email as a Placement check, with Alex at Example Ltd in place of each Person's details, to these Mailboxes of other Circle members:",
    receivers.join("\n"),
    "A person runs each of these Mailboxes and can read the email. They may keep a copy.",
  ].join("\n\n");
/** The snapshot kind a content check's approval binds. */
export const CONTENT_TEST_KIND = "placement_content_test";

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const norm = (a: string) => a.trim().toLowerCase();
const versionOf = (t: Pick<ContentTestRow, "saidBy" | "wordingVersion">) => `${t.saidBy}:${t.wordingVersion}`;

async function liveContentTest(tx: PlacementTx, campaignId: string, stepKey: string): Promise<ContentTestRow | null> {
  const t = await currentContentTest(tx, campaignId, stepKey);
  return t?.wordingVersion === CONTENT_TEST_WORDING_VERSION ? t : null;
}

/** The live version of a bound yes; null once a newer yes for its step replaced it or the words changed. */
export const contentTestVersion: Resolver = async (tx, id) => {
  const t = await contentTestById(tx, id);
  const live = t ? await liveContentTest(tx, t.campaignId, t.stepKey) : null;
  return live?.id === id ? versionOf(live) : null;
};

export type ContentYes = { campaignId: string; stepKey: string; receivers: string[]; wordingVersion: string };
type Refusal = "not_available" | "forbidden" | "stale_wording" | "bad_receivers" | "not_found";

export function createContentTests(deps: { deployment: () => Deployment; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const off = () => deps.deployment() === "cloud";

  return {
    /** Records a person's yes to one template step's content test, for the receivers they were shown. */
    async record(workspaceId: string, member: { userId: string; role: Role }, y: ContentYes): Promise<{ ok: true; id: string } | { ok: false; reason: Refusal }> {
      if (off()) return { ok: false, reason: "not_available" };
      if (!can(member.role, "item.approve")) return { ok: false, reason: "forbidden" };
      if (y.wordingVersion !== CONTENT_TEST_WORDING_VERSION) return { ok: false, reason: "stale_wording" };
      const receivers = [...new Set(y.receivers.map(norm))];
      if (!receivers.length || receivers.length > 50 || !receivers.every((r) => ADDRESS.test(r))) return { ok: false, reason: "bad_receivers" };
      return inWorkspace(workspaceId, async (tx) => {
        if (!(await isTemplateStep(tx, y.campaignId, y.stepKey))) return { ok: false as const, reason: "not_found" as const };
        const row = await insertContentTest(tx, { workspaceId, campaignId: y.campaignId, stepKey: y.stepKey, receivers, wordingVersion: CONTENT_TEST_WORDING_VERSION, saidBy: member.userId, saidAt: now() });
        return { ok: true as const, id: row.id };
      });
    },

    /** The step a content check renders: the one this Workspace said yes to most recently, while that yes is on today's words. */
    async newestStep(workspaceId: string): Promise<{ campaignId: string; stepKey: string } | null> {
      if (off()) return null;
      const t = await inWorkspace(workspaceId, newestContentTest);
      return t?.wordingVersion === CONTENT_TEST_WORDING_VERSION ? { campaignId: t.campaignId, stepKey: t.stepKey } : null;
    },

    /**
     * Whether a content check of this step may go to this receiver, and what its approval binds: nothing
     * for this Workspace's own Mailbox, the step's live yes when that yes names the receiver. Null means
     * it may not be sent.
     */
    async binding(workspaceId: string, probe: { campaignId: string; stepKey: string; receiver: string }): Promise<SnapshotEntry[] | null> {
      if (off()) return null;
      const receiver = norm(probe.receiver);
      return inWorkspace(workspaceId, async (tx) => {
        if (await isOwnMailbox(tx, receiver)) return [];
        const t = await liveContentTest(tx, probe.campaignId, probe.stepKey);
        return t?.receivers.includes(receiver) ? [{ kind: CONTENT_TEST_KIND, id: t.id, version: versionOf(t) }] : null;
      });
    },
  };
}
export type ContentTests = ReturnType<typeof createContentTests>;
