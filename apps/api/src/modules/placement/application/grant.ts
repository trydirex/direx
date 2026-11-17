// SPDX-License-Identifier: AGPL-3.0-only
// Whether a Mailbox may take part in Placement checks. Only the person who connected it, holding
// rule.grant, can say yes, after reading what is read and sent and to whom; no answer is no. Any
// Workspace member can stop it, which cancels its placement Actions not yet sent. Every placement
// Action is approved in the granter's name and binds the grant, so a stop, a demotion or new words
// hold it at claim and at dispatch. Never on Direx's cloud.
import { credentialSettings } from "../../credentials/index";
import { approverFromMember, can, mayGrantRules, type Role } from "../../identity/index";
import type { ApproverId, Check, Ledger, Resolver, SnapshotEntry } from "../../ledger/index";
import type { Deployment } from "../../models/index";
import { PLACEMENT_EFFECTS } from "../../plugins/index";
import { currentGrant, grantById, inWorkspace, insertGrant, stopGrant, type GrantRow, type PlacementTx } from "../adapters/repo";
import { resultsIn, type Results } from "./results";

/** Bumped whenever the words below change; a yes given on older words pauses placement until answered again. */
export const PLACEMENT_WORDING_VERSION = "2026-11-10";
/** Shown right before the yes or no, with neither chosen. */
export const PLACEMENT_WORDING = [
  "Placement checks find out where your email lands. If you say yes, this Mailbox joins the Placement circle: other Circle members send it a few test emails a day, and it sends them some.",
  "What Direx reads in this Mailbox: only the folder labels of the Placement checks it expects. Never their text, and never any other email.",
  "What Direx sends: for each check this Mailbox receives, the day, the sender, the receiver, the message identity and the verdict (primary, another tab, spam or missing).",
  "Who receives it: the Circle member who sent that check, as an email to their Mailbox, where a person can read it.",
  "Why: this serves the reciprocal placement feature, so every Circle member learns where their own email lands.",
  "Any member of this Workspace can stop it at any time. Not answering means no.",
].join("\n\n");
/** The snapshot kind a placement Action's approval binds. */
export const GRANT_KIND = "placement_grant";

export const isPlacementCapability = (capability: string) => PLACEMENT_EFFECTS.has(capability.slice(capability.lastIndexOf("/") + 1));

const versionOf = (g: Pick<GrantRow, "answeredBy" | "wordingVersion">) => `${g.answeredBy}:${g.wordingVersion}`;
const addressOf = (s: { key: string; meta: Record<string, unknown> }) => String(s.meta.username ?? s.key).trim().toLowerCase();
const isYesUnstopped = (g: GrantRow | undefined): g is GrantRow => g?.answer === "yes" && !g.stoppedAt;

/** The grant placement runs under now: the Mailbox's newest answer, a yes on today's words, not stopped, from someone who still holds rule.grant. */
async function liveGrant(tx: PlacementTx, credentialId: string): Promise<GrantRow | null> {
  const g = await currentGrant(tx, credentialId);
  return isYesUnstopped(g) && g.wordingVersion === PLACEMENT_WORDING_VERSION && (await mayGrantRules(tx, g.answeredBy)) ? g : null;
}

/** The live version of a bound grant; null once it is stopped, replaced, on old words or its granter lost rule.grant. */
export const placementGrantVersion: Resolver = async (tx, id) => {
  const g = await grantById(tx, id);
  const live = g ? await liveGrant(tx, g.credentialId) : null;
  return live?.id === id ? versionOf(live) : null;
};

/** No placement Action goes out without a live grant in its approver's name, and none at all on the cloud. */
export const placementGranted =
  (deployment: () => Deployment): Check =>
  async (tx, action, approval) => {
    if (!isPlacementCapability(action.capability)) return { kind: "ok" };
    if (deployment() === "cloud") return { kind: "block", reason: "placement_not_available" };
    const g = action.credentialId ? await liveGrant(tx, action.credentialId) : null;
    return g && g.answeredBy === approval.approverId ? { kind: "ok" } : { kind: "hold", reason: "placement_not_granted", detail: "this Mailbox has no live yes to Placement checks from its approver" };
  };

/**
 * The provider refused a placement Action as over the Mailbox's sending limit or as abuse: placement
 * stops for that Mailbox, in the same transaction, until a person says yes again. Its pending checks
 * are then held by the live grant check, and cancelled once their time has passed.
 */
export const stopOnAccountLimit =
  (now: () => Date) =>
  async (tx: PlacementTx, action: { capability: string; credentialId: string | null }, limit: "sending_limit" | "abuse"): Promise<void> => {
    if (!isPlacementCapability(action.capability) || !action.credentialId) return;
    const g = await currentGrant(tx, action.credentialId);
    if (isYesUnstopped(g)) await stopGrant(tx, g.id, { stoppedBy: null, stoppedAt: now(), stopReason: `The provider refused a placement email: ${limit === "abuse" ? "abuse" : "sending limit"}` });
  };

export type PlacementStatus = "unanswered" | "no" | "on" | "stopped" | "wording_changed" | "granter_lost";
export type PlacementState = {
  address: string;
  status: PlacementStatus;
  wordingVersion: string;
  wording: string;
  /** Whether the person asking may answer: they connected the Mailbox and hold rule.grant. */
  mayAnswer: boolean;
  grant: Pick<GrantRow, "id" | "answer" | "wordingVersion" | "answeredBy" | "answeredAt" | "stoppedBy" | "stoppedAt" | "stopReason"> | null;
};
type Member = { userId: string; role: Role };
type Refusal = "not_available" | "not_found" | "stale_wording" | "not_connector" | "forbidden" | "already_on" | "address_mismatch" | "not_on";
export type Answer = { answer: "yes" | "no"; wordingVersion: string; confirmAddress?: string | undefined };

export function createPlacement(deps: { ledger: () => Pick<Ledger, "cancelPendingIn">; deployment: () => Deployment; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const off = () => deps.deployment() === "cloud";

  async function stateIn(tx: PlacementTx, credentialId: string, member: Member): Promise<PlacementState | null> {
    const settings = await credentialSettings(tx, credentialId);
    if (!settings) return null;
    const g = await currentGrant(tx, credentialId);
    const status: PlacementStatus = !g ? "unanswered" : g.answer === "no" ? "no" : g.stoppedAt ? "stopped" : g.wordingVersion !== PLACEMENT_WORDING_VERSION ? "wording_changed" : (await mayGrantRules(tx, g.answeredBy)) ? "on" : "granter_lost";
    const grant = g ? { id: g.id, answer: g.answer, wordingVersion: g.wordingVersion, answeredBy: g.answeredBy, answeredAt: g.answeredAt, stoppedBy: g.stoppedBy, stoppedAt: g.stoppedAt, stopReason: g.stopReason } : null;
    return { address: addressOf(settings), status, wordingVersion: PLACEMENT_WORDING_VERSION, wording: PLACEMENT_WORDING, mayAnswer: settings.createdBy === member.userId && can(member.role, "rule.grant"), grant };
  }

  type Out = { ok: true; state: PlacementState } | { ok: false; reason: Refusal };

  return {
    async read(workspaceId: string, credentialId: string, member: Member): Promise<Out> {
      if (off()) return { ok: false, reason: "not_available" };
      const state = await inWorkspace(workspaceId, (tx) => stateIn(tx, credentialId, member));
      return state ? { ok: true, state } : { ok: false, reason: "not_found" };
    },

    /** What this Mailbox's checks found, and the reports it sent; any member reads it. */
    async results(workspaceId: string, credentialId: string): Promise<{ ok: true; results: Results } | { ok: false; reason: "not_available" | "not_found" }> {
      if (off()) return { ok: false, reason: "not_available" };
      return inWorkspace(workspaceId, async (tx) => ((await credentialSettings(tx, credentialId)) ? { ok: true as const, results: await resultsIn(tx, credentialId) } : { ok: false as const, reason: "not_found" as const }));
    },

    /** Records a yes or a no from the person who connected the Mailbox; a yes needs its address typed back. */
    async answer(workspaceId: string, credentialId: string, member: Member, a: Answer): Promise<Out> {
      if (off()) return { ok: false, reason: "not_available" };
      if (a.wordingVersion !== PLACEMENT_WORDING_VERSION) return { ok: false, reason: "stale_wording" };
      return inWorkspace(workspaceId, async (tx): Promise<Out> => {
        const before = await stateIn(tx, credentialId, member);
        if (!before) return { ok: false, reason: "not_found" };
        const settings = await credentialSettings(tx, credentialId);
        if (settings?.createdBy !== member.userId) return { ok: false, reason: "not_connector" };
        if (!can(member.role, "rule.grant")) return { ok: false, reason: "forbidden" };
        // A live yes is turned off by stopping it, which also cancels what it would send.
        if (before.status === "on") return { ok: false, reason: "already_on" };
        if (a.answer === "yes" && a.confirmAddress?.trim().toLowerCase() !== before.address) return { ok: false, reason: "address_mismatch" };
        await insertGrant(tx, { workspaceId, credentialId, answer: a.answer, wordingVersion: PLACEMENT_WORDING_VERSION, answeredBy: member.userId, answeredAt: now() });
        return { ok: true, state: (await stateIn(tx, credentialId, member))! };
      });
    },

    /** Any member stops a yes in one action; its placement Actions not yet sent are cancelled with it. */
    async stop(workspaceId: string, credentialId: string, member: Member, reason: string): Promise<{ ok: true; cancelled: number; state: PlacementState } | { ok: false; reason: Refusal }> {
      if (off()) return { ok: false, reason: "not_available" };
      return inWorkspace(workspaceId, async (tx) => {
        const g = await currentGrant(tx, credentialId);
        if (!(await credentialSettings(tx, credentialId))) return { ok: false as const, reason: "not_found" as const };
        const stopped = isYesUnstopped(g) ? await stopGrant(tx, g.id, { stoppedBy: member.userId, stoppedAt: now(), stopReason: reason }) : undefined;
        if (!stopped) return { ok: false as const, reason: "not_on" as const };
        const cancelled = await deps.ledger().cancelPendingIn(tx, credentialId, { userId: member.userId }, isPlacementCapability);
        return { ok: true as const, cancelled, state: (await stateIn(tx, credentialId, member))! };
      });
    },

    /**
     * What a placement Action's approval binds: the live grant, in its granter's name, whose own yes
     * from their session is the approval. Null while there is none, so nothing can be approved.
     */
    async binding(workspaceId: string, credentialId: string): Promise<{ approverId: ApproverId; snapshot: SnapshotEntry[] } | null> {
      if (off()) return null;
      const g = await inWorkspace(workspaceId, (tx) => liveGrant(tx, credentialId));
      return g && { approverId: approverFromMember({ userId: g.answeredBy }), snapshot: [{ kind: GRANT_KIND, id: g.id, version: versionOf(g) }] };
    },
  };
}
export type Placement = ReturnType<typeof createPlacement>;
