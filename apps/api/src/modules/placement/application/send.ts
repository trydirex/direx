// SPDX-License-Identifier: AGPL-3.0-only
// Sending Placement checks. Once a day, each Mailbox with a live yes that is on the trusted member
// list gets the checks the day's seed pairs it with, as Actions due at their expected time and
// approved in the granter's name with the grant bound. A plain check waits for the library's
// approval; a content check needs a template step this Workspace said yes to for that receiver.
// Checks are capped per Mailbox per day under the Mailbox's lock and count toward its provider
// ceiling. A check skipped is recorded with why, and one not sent within 30 minutes of its time is
// cancelled and recorded too, so a report can tell either from a check that went missing.
import { templateStep } from "../../campaigns/index";
import { credentialSettings } from "../../credentials/index";
import type { Check, Ledger, SnapshotEntry } from "../../ledger/index";
import type { Deployment } from "../../models/index";
import { senderIdentity } from "../../outreach/index";
import { lockMailboxDay, PROVIDER_CEILING } from "../../schedule/index";
import { approvalBinds, checksMade, inWorkspace, insertProbe, isOwnMailbox, isReportOf, lateChecks, markNotSent, markUnknown, probeByAction, probeByArchive, probeRow, reportsMade, unknownPlacement, type ProbeRow } from "../adapters/repo";
import { LIBRARY_APPROVED } from "../domain/library";
import { CONTENT_TEST_KIND, type ContentTests } from "./content-tests";
import type { Placement } from "./grant";
import type { JoinFor } from "./join";
import { trustList } from "./list";
import { googleMx, type ResolveMx } from "./mx";
import { contentSubject, pairDay, probeIdentity, receiversFor, seed, type ProbeKind } from "./pairing";
import { contentProbe, plainProbe } from "./render";

/** Checks a Mailbox sends a day [DEFAULT], and fewer while it has been listed under 4 weeks, unless the founder controls it. */
export const DAILY_CAP = 10;
export const NEW_MEMBER_CAP = 5;
export const NEW_MEMBER_DAYS = 28;
/** Receivers read at most 2 content checks per sender a week, so no more are sent [DEFAULT]. */
export const CONTENT_PER_WEEK = 2;
/** A check not sent this long after its expected time is cancelled [DEFAULT]. */
export const CANCEL_AFTER_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
const SEQ: Record<ProbeKind, number> = { plain: 0, content: 1 };

const norm = (a: string) => a.trim().toLowerCase();
export const daysFrom = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
/** The Monday of the UTC week holding `day`. */
export const weekOf = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);

export type NotToday = "not_available" | "not_granted" | "provider_cannot_send" | "no_list" | "not_listed" | "sender_identity_missing";

export function createSending(deps: {
  placement: Pick<Placement, "binding">;
  contentTests: Pick<ContentTests, "binding" | "newestStep">;
  ledger: () => Pick<Ledger, "createActionIn" | "submitForApproval" | "approve" | "getAction" | "cancel" | "cancelUnknown">;
  sendFor: JoinFor;
  deployment: () => Deployment;
  trust?: (workspaceId: string) => ReturnType<typeof trustList>;
  resolveMx?: ResolveMx;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  const trust = deps.trust ?? ((workspaceId: string) => trustList(workspaceId));

  return {
    /** Makes today's checks from this Mailbox; a second run the same day makes nothing new. */
    async daily(workspaceId: string, credentialId: string): Promise<{ ok: true; made: number; skipped: number } | { ok: false; reason: NotToday }> {
      const at = now();
      const off = (reason: NotToday) => ({ ok: false as const, reason });
      if (deps.deployment() === "cloud") return off("not_available");
      const grant = await deps.placement.binding(workspaceId, credentialId);
      if (!grant) return off("not_granted");
      const effect = await deps.sendFor(workspaceId, credentialId);
      if (!effect) return off("provider_cannot_send");
      const list = await trust(workspaceId);
      if (!list.ok) return off("no_list");
      const found = await inWorkspace(workspaceId, async (tx) => ({ settings: await credentialSettings(tx, credentialId), sender: await senderIdentity(tx) }));
      const address = norm(String(found.settings?.meta.username ?? found.settings?.key ?? ""));
      const members = list.trusted.list.members;
      const me = members.find((m) => m.address === address);
      if (!me) return off("not_listed");
      if (!found.sender) return off("sender_identity_missing");
      const sender = { address, ...found.sender };

      const s = seed(at, list.trusted.contentHash);
      const isNew = !me.founder_controlled && daysFrom(me.listed_at, s.day) < NEW_MEMBER_DAYS;
      const step = await deps.contentTests.newestStep(workspaceId);
      const template = step && (await templateStep(workspaceId, step.campaignId, step.stepKey, at));
      const content = template && contentProbe(template, template.urls, sender);
      const mx = new Map<string, Promise<boolean>>();
      const googleMail = (a: string) => {
        const domain = a.slice(a.lastIndexOf("@") + 1);
        if (!mx.has(domain)) mx.set(domain, googleMx(domain, deps.resolveMx));
        return mx.get(domain)!;
      };
      const ownMx = await googleMail(address);
      const receivers = receiversFor(s, address, members).map((r) => members.find((m) => m.address === r)!);

      let made = 0;
      let skipped = 0;
      // Plain checks first, so a day over the cap still checks every receiver plainly.
      for (const kind of ["plain", "content"] as const) {
        if (kind === "plain" && !LIBRARY_APPROVED) continue;
        // No step said yes to: nothing to render, so no content check is planned.
        if (kind === "content" && !content?.ok) continue;
        for (const peer of receivers) {
          const id = probeIdentity(s, me, peer, kind);
          let skip: string | null = !ownMx ? "sender_mx" : !(await googleMail(peer.address)) ? "receiver_mx" : id.expectedAt.getTime() + CANCEL_AFTER_MS <= at.getTime() ? "not_sent" : null;
          let input: unknown = null;
          const snapshot: SnapshotEntry[] = [...grant.snapshot, ...(effect.version ? [{ kind: "capability", id: effect.id, version: effect.version }] : [])];
          if (kind === "plain") {
            input = { to: [peer.address], ...plainProbe(sender, peer.address, pairDay(s, me, peer)) };
          } else if (content?.ok && step) {
            const yes = isNew ? null : await deps.contentTests.binding(workspaceId, { ...step, receiver: peer.address });
            skip ??= isNew ? "new_member" : yes ? null : "no_content_yes";
            if (yes) snapshot.push(...yes);
            input = { to: [peer.address], subject: contentSubject(content.probe.subject, id), text: content.probe.text };
          }
          const spec = skip ? null : (await effect.prepare(workspaceId, input)).spec;

          const row = await inWorkspace(workspaceId, async (tx): Promise<ProbeRow> => {
            const emails = await lockMailboxDay(tx, credentialId, id.expectedAt, at);
            const key = { credentialId, direction: "send", day: s.day, peer: peer.address, kind };
            const existing = await probeRow(tx, key);
            if (existing) return existing;
            const today = await checksMade(tx, credentialId, { day: s.day });
            if (!skip && today >= (isNew ? NEW_MEMBER_CAP : DAILY_CAP)) skip = "daily_cap";
            if (!skip && emails + today + (await reportsMade(tx, credentialId, s.day)) >= PROVIDER_CEILING) skip = "provider_ceiling";
            if (!skip && kind === "content" && (await checksMade(tx, credentialId, { since: weekOf(s.day), peer: peer.address, kind })) >= CONTENT_PER_WEEK) skip = "content_week_cap";
            const action = skip
              ? null
              : (await deps.ledger().createActionIn(tx, workspaceId, { idempotencyKey: `placement_send:${credentialId}:${s.day}:${peer.address}:${kind}`, capability: effect.id, dedupe: effect.dedupe, spec, credentialId, actor: { system: "placement" } })).action;
            return insertProbe(tx, { workspaceId, ...key, listVersion: list.trusted.version, seq: SEQ[kind], expectedAt: id.expectedAt, actionId: action?.id ?? null, skipReason: skip, createdAt: at });
          });
          if (!row.actionId) {
            skipped++;
            continue;
          }
          if (await approvePlacement(deps.ledger(), workspaceId, row.actionId, grant.approverId, snapshot, id.expectedAt)) made++;
        }
      }
      return { ok: true, made, skipped };
    },

    /**
     * Cancels every check of this Workspace still unsent 30 minutes after its time, and records it as
     * not sent. A check, join or archive whose outcome is unknown waits for no person: it is cancelled
     * at once, never resent, and a check is recorded as unknown, so no report counts it.
     */
    async cancelLate(workspaceId: string): Promise<number> {
      let cancelled = 0;
      for (const u of await inWorkspace(workspaceId, (tx) => unknownPlacement(tx))) {
        if (!(await deps.ledger().cancelUnknown(workspaceId, u.id, { system: "placement" })).ok) continue;
        await inWorkspace(workspaceId, (tx) => markUnknown(tx, u.id));
        cancelled++;
      }
      const late = await inWorkspace(workspaceId, (tx) => lateChecks(tx, new Date(now().getTime() - CANCEL_AFTER_MS)));
      for (const c of late) {
        // Unknown since the pass above: the next sweep cancels it.
        if (c.holdReason === "outcome_unknown") continue;
        const ended = c.state === "cancelled" || c.state === "blocked" || (await deps.ledger().cancel(workspaceId, c.actionId, { system: "placement" })).ok;
        if (!ended) continue;
        await inWorkspace(workspaceId, (tx) => markNotSent(tx, c.id, "not_sent"));
        cancelled++;
      }
      return cancelled;
    },
  };
}
export type Sending = ReturnType<typeof createSending>;

/** Submits and approves a placement Action in its granter's name; a rerun picks up where it stopped. */
export async function approvePlacement(
  ledger: Pick<Ledger, "submitForApproval" | "approve" | "getAction">,
  workspaceId: string,
  actionId: string,
  approverId: Parameters<Ledger["approve"]>[2]["approverId"],
  snapshot: SnapshotEntry[],
  dueAt?: Date,
): Promise<boolean> {
  let action = await ledger.getAction(workspaceId, actionId);
  if (action?.state === "draft") {
    const submitted = await ledger.submitForApproval(workspaceId, actionId, { system: "placement" });
    action = submitted.ok ? submitted.action : undefined;
  }
  if (action?.state !== "needs_approval") return false;
  return (await ledger.approve(workspaceId, actionId, { approverId, draftVersion: action.draftVersion, snapshot, ...(dueAt && { dueAt }) })).ok;
}

/**
 * At claim and at dispatch: a Placement check goes out only as the daily job made it, within 30
 * minutes of its time, and a content check to another member only with that step's yes bound. An
 * archive goes out only for a content check this Mailbox received, after its verdict, never from spam,
 * and a report only as the daily job made it.
 */
export const placementSendCheck =
  (now: () => Date): Check =>
  async (tx, action) => {
    if (action.capability.endsWith("/placement.archive")) {
      const probe = await probeByArchive(tx, action.id);
      const ok = probe?.direction === "receive" && probe.kind === "content" && (probe.verdict === "primary" || probe.verdict === "other_tab") && probe.credentialId === action.credentialId;
      return ok ? { kind: "ok" } : { kind: "block", reason: "placement_not_archivable", detail: "only a content check received here, read and not in spam, may be archived" };
    }
    if (action.capability.endsWith("/placement.report")) {
      return (await isReportOf(tx, action.id, action.credentialId)) ? { kind: "ok" } : { kind: "block", reason: "placement_unknown_report", detail: "only a report the daily job made for checks this Mailbox read may go out" };
    }
    if (!action.capability.endsWith("/placement.send")) return { kind: "ok" };
    const probe = await probeByAction(tx, action.id);
    if (!probe) return { kind: "hold", reason: "placement_unknown_check", detail: "no Placement check was planned for this Action" };
    if (now().getTime() > probe.expectedAt.getTime() + CANCEL_AFTER_MS) return { kind: "hold", reason: "placement_too_late", detail: `expected at ${probe.expectedAt.toISOString()}` };
    if (probe.kind === "content" && !(await isOwnMailbox(tx, probe.peer)) && !(await approvalBinds(tx, action.id, CONTENT_TEST_KIND))) {
      return { kind: "hold", reason: "placement_no_content_yes", detail: "a content check to another Circle member needs a yes to that test" };
    }
    return { kind: "ok" };
  };
