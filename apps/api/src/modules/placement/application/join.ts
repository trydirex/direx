// SPDX-License-Identifier: AGPL-3.0-only
// Joining the Placement circle from a Mailbox. The signer emailed join code part 1 to the Mailbox and
// gave its person part 2; the person pastes both here, with the Message-ID of the part 1 email and
// the address it came from. The install answers with one placement.join Action from the Mailbox: a
// reply to that email carrying both parts, the member key, and the key's signature over them,
// approved by binding the live grant in its granter's name.
import { createHash } from "node:crypto";
import type { DedupeClass } from "@direx/plugin-sdk";
import { credentialSettings } from "../../credentials/index";
import { approverFromMember } from "../../identity/index";
import type { Ledger } from "../../ledger/index";
import type { Deployment } from "../../models/index";
import { inWorkspace } from "../adapters/repo";
import { JOIN_SUBJECT, joinSigned, joinText } from "../domain/join";
import type { Placement } from "./grant";

/** The Mailbox provider's placement.join effect, when it has one. */
export type JoinFor = (
  workspaceId: string,
  credentialId: string,
) => Promise<{ id: string; dedupe: DedupeClass; version?: string | undefined; prepare: (workspaceId: string, input: unknown) => Promise<{ spec: unknown }> } | undefined>;

export type MemberKeys = {
  publicKey: (workspaceId: string, credentialId: string) => Promise<string>;
  sign: (workspaceId: string, credentialId: string, data: Uint8Array) => Promise<string>;
};

export type JoinRequest = { part1: string; part2: string; signer: string; messageId: string };
export type JoinRefusal = "not_available" | "not_found" | "not_granted" | "not_granter" | "provider_cannot_join" | "not_approved";

export function createJoin(deps: {
  placement: Pick<Placement, "binding">;
  ledger: () => Pick<Ledger, "createActionIn" | "submitForApproval" | "approve">;
  joinFor: JoinFor;
  memberKeys: () => MemberKeys;
  deployment: () => Deployment;
}) {
  return {
    /** One placement.join Action, approved and scheduled; the same codes again give the same Action. */
    async join(workspaceId: string, credentialId: string, member: { userId: string }, r: JoinRequest): Promise<{ ok: true; actionId: string } | { ok: false; reason: JoinRefusal }> {
      if (deps.deployment() === "cloud") return { ok: false, reason: "not_available" };
      const settings = await inWorkspace(workspaceId, (tx) => credentialSettings(tx, credentialId));
      if (!settings) return { ok: false, reason: "not_found" };
      const b = await deps.placement.binding(workspaceId, credentialId);
      if (!b) return { ok: false, reason: "not_granted" };
      // The approval is the granter's yes, so only the granter sends it.
      if (b.approverId !== approverFromMember(member)) return { ok: false, reason: "not_granter" };
      const effect = await deps.joinFor(workspaceId, credentialId);
      if (!effect) return { ok: false, reason: "provider_cannot_join" };

      const address = String(settings.meta.username ?? settings.key).trim().toLowerCase();
      const keys = deps.memberKeys();
      const j = { part1: r.part1, part2: r.part2, address, key: await keys.publicKey(workspaceId, credentialId) };
      const sig = await keys.sign(workspaceId, credentialId, Buffer.from(joinSigned(j)));
      const { spec } = await effect.prepare(workspaceId, { to: [r.signer], subject: JOIN_SUBJECT, text: joinText({ ...j, sig }), inReplyTo: r.messageId, references: [r.messageId] });

      const ledger = deps.ledger();
      const actor = { userId: member.userId };
      const codes = createHash("sha256").update(`${r.part1}\n${r.part2}`).digest("hex");
      const { action } = await inWorkspace(workspaceId, (tx) => ledger.createActionIn(tx, workspaceId, { idempotencyKey: `placement_join:${credentialId}:${codes}`, capability: effect.id, dedupe: effect.dedupe, spec, credentialId, actor }));
      if (action.state === "draft") {
        const submitted = await ledger.submitForApproval(workspaceId, action.id, actor);
        if (!submitted.ok) return { ok: false, reason: "not_approved" };
      }
      if (action.state === "draft" || action.state === "needs_approval") {
        const snapshot = [...b.snapshot, ...(effect.version ? [{ kind: "capability", id: effect.id, version: effect.version }] : [])];
        const approved = await ledger.approve(workspaceId, action.id, { approverId: b.approverId, draftVersion: action.draftVersion, snapshot });
        if (!approved.ok) return { ok: false, reason: "not_approved" };
      }
      return { ok: true, actionId: action.id };
    },
  };
}
export type PlacementJoin = ReturnType<typeof createJoin>;
