// SPDX-License-Identifier: AGPL-3.0-only
// Whether a Mailbox's provider delivers Direx's opt-out as sent. Connect and Check again send one
// probe to the Mailbox's own sign-in address, through the ledger like any send, approved by the
// person who clicked; reading it back and comparing decides whether cold mail may go from it.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DedupeClass } from "@direx/plugin-sdk";
import { storedSpec } from "@direx/plugin-sdk/host";
import { credentialSettings } from "../../credentials";
import type { Items } from "../../items";
import type { ApproverId, Check, Ledger, SnapshotEntry } from "../../ledger";
import { MAILBOX_PROBE, type QueryId, type QueryOf } from "../../plugins";
import { currentCheck, currentChecks, probesSince, settleCheck, startCheck, type HeaderCheck } from "../adapters/header-checks";
import { inWorkspace, readSettings, type OutreachTx } from "../adapters/repo";
import { isPublicHttps, optOutFooter } from "../domain/footer";
import { compareProbe } from "../domain/header-check";

/** Bumped whenever the connect form's words about the probe change; an approval binds it. */
export const PROBE_WORDING_VERSION = "2026-11-05";
export const PROBE_WORDING = "mailbox_probe";
export const PROBE_TEXT = "This is an automatic check from Direx. It tests that your email provider delivers the opt-out at the end of this message exactly as Direx sent it. You can delete this message.";

const DAY_MS = 24 * 60 * 60 * 1000;
const PROBES_PER_DAY = 5;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isProbeCapability = (capability: string) => capability.endsWith(`/${MAILBOX_PROBE}`);

/** The provider's probe pair for this Mailbox, or none when it can't be checked. */
export type ProbeFor = (
  workspaceId: string,
  credentialId: string,
) => Promise<{ send: { id: string; dedupe: DedupeClass; version?: string | undefined; prepare: (ws: string, input: unknown) => Promise<{ spec: unknown }> }; read: QueryId<"mailbox.probe_read"> } | undefined>;

export type HeaderCheckDeps = {
  items: () => Pick<Items, "createActionItem" | "submitItem" | "approve" | "actionIdOf">;
  probeFor: ProbeFor;
  baseUrl: () => string;
  now?: () => Date;
};

type Settings = NonNullable<Awaited<ReturnType<typeof credentialSettings>>>;

/** The address a probe goes to: the sign-in, since receiving the probe there is what proves it. */
// A password Mailbox signs in with `username`; a Gmail one keeps its address in `accountEmail`, its key being `google:<address>`.
export const signInOf = (s: Pick<Settings, "key" | "meta">) => String(s.meta.username ?? s.meta.accountEmail ?? s.key).trim().toLowerCase();

/** What a result is bound to: change the sender, servers or sign-in and the Mailbox is unchecked again. */
export const settingsHash = (s: Pick<Settings, "connection" | "key" | "meta">) =>
  createHash("sha256")
    .update(JSON.stringify([s.connection, s.key, Object.entries(s.meta).sort(([a], [b]) => a.localeCompare(b))]))
    .digest("hex");

export type StartProbe =
  | { ok: true; check: HeaderCheck }
  | { ok: false; reason: "stale_wording" | "mailbox_not_found" | "daily_limit" | "provider_refused_recently" | "not_approved" };

export function createHeaderCheck(deps: HeaderCheckDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    /** Connect or Check again: one probe, approved by the person who clicked, or a reason there is none. */
    async start(workspaceId: string, credentialId: string, a: { approverId: ApproverId; userId: string; may: (permission: string) => boolean; wordingVersion: string }): Promise<StartProbe> {
      if (a.wordingVersion !== PROBE_WORDING_VERSION) return { ok: false, reason: "stale_wording" };
      const at = now();
      const found = await inWorkspace(workspaceId, async (tx) => {
        const settings = await credentialSettings(tx, credentialId);
        if (!settings) return null;
        return { settings, current: await currentCheck(tx, credentialId), sent: await probesSince(tx, credentialId, new Date(at.getTime() - DAY_MS)), sender: await readSettings(tx) };
      });
      if (!found) return { ok: false, reason: "mailbox_not_found" };
      const { settings, current, sender } = found;
      const hash = settingsHash(settings);
      // A second click while one probe is out gets that probe, not another.
      if (current?.state === "pending" && current.settingsHash === hash) return { ok: true, check: current };
      if (current?.state === "failed" && current.reason === "provider_refused" && current.settledAt && at.getTime() - current.settledAt.getTime() < DAY_MS) {
        return { ok: false, reason: "provider_refused_recently" };
      }
      if (found.sent >= PROBES_PER_DAY) return { ok: false, reason: "daily_limit" };

      const unchecked = (reason: string) =>
        inWorkspace(workspaceId, (tx) => startCheck(tx, { workspaceId, credentialId, probeActionId: null, probeSubject: null, settingsHash: hash, state: "unchecked", reason, createdBy: a.userId, createdAt: at }));
      const probe = await deps.probeFor(workspaceId, credentialId);
      if (!probe) return { ok: true, check: await unchecked("provider_cannot_check") };
      const to = signInOf(settings);
      if (!EMAIL.test(to)) return { ok: true, check: await unchecked("sign_in_not_email") };
      if (!sender?.senderName || !sender.postalAddress) return { ok: true, check: await unchecked("sender_identity_missing") };

      // A token Direx never issued, so the probe's unsubscribe link can't suppress anyone.
      const base = deps.baseUrl();
      const url = isPublicHttps(base) ? `${base}/api/unsubscribe/${workspaceId}/probe-${randomBytes(16).toString("hex")}` : null;
      const footer = optOutFooter({ senderName: sender.senderName, postalAddress: sender.postalAddress, unsubscribeUrl: url });
      const subject = `Direx Mailbox check ${randomUUID().slice(0, 8)}`;
      const { spec } = await probe.send.prepare(workspaceId, { to: [to], subject, text: `${PROBE_TEXT}\n\n${footer}`, ...(url ? { listUnsubscribe: url } : {}) });
      const snapshot: SnapshotEntry[] = [
        { kind: "credential", id: credentialId, version: settings.key },
        { kind: "wording", id: PROBE_WORDING, version: PROBE_WORDING_VERSION },
        ...(probe.send.version ? [{ kind: "capability", id: probe.send.id, version: probe.send.version }] : []),
      ];
      const items = deps.items();
      // ponytail: two clicks in the same minute share one Action; per-click keys if that ever matters.
      const item = await items.createActionItem(workspaceId, {
        idempotencyKey: `mailbox_probe:${credentialId}:${hash}:${Math.floor(at.getTime() / 60_000)}`,
        capability: probe.send.id,
        dedupe: probe.send.dedupe,
        spec,
        credentialId,
        actor: { userId: a.userId },
        details: { title: `Mailbox check for ${to}`, workArea: "outreach", channel: "email", plannedAt: null, warnings: [], snapshot },
      });
      const actionId = await items.actionIdOf(workspaceId, item.id);
      if (!actionId) return { ok: false, reason: "not_approved" };
      const check = await inWorkspace(workspaceId, async (tx) => {
        const again = await currentCheck(tx, credentialId);
        if (again && again.probeActionId === actionId) return again;
        return startCheck(tx, { workspaceId, credentialId, probeActionId: actionId, probeSubject: subject, settingsHash: hash, state: "pending", createdBy: a.userId, createdAt: at });
      });
      // Clicking Connect or Check again is the approval: the form showed this probe's recipient and words.
      const submitted = item.state === "draft" ? await items.submitItem(workspaceId, item.id, { userId: a.userId }) : { ok: true as const, item };
      if (!submitted.ok) return { ok: false, reason: "not_approved" };
      if (submitted.item.state === "needs_approval") {
        const approved = await items.approve(workspaceId, item.id, submitted.item.revision, { approverId: a.approverId, may: a.may });
        if (!approved.ok) return { ok: false, reason: "not_approved" };
      }
      return { ok: true, check };
    },
  };
}
export type HeaderChecks = ReturnType<typeof createHeaderCheck>;

/** The snapshot version for the probe's wording, so a probe approved on old words isn't sent. */
export const probeWordingVersion = async (_tx: OutreachTx, id: string) => (id === PROBE_WORDING ? PROBE_WORDING_VERSION : null);

/** Blocks a probe addressed to anything but its Mailbox's own sign-in, at claim and at dispatch. */
export const probeRecipient: Check = async (tx, action) => {
  if (!isProbeCapability(action.capability)) return { kind: "ok" };
  const settings = action.credentialId ? await credentialSettings(tx, action.credentialId) : null;
  const spec = storedSpec("mailbox.probe", action.spec);
  const addresses = [...(spec.to ?? []), ...(spec.cc ?? [])].map((r) => (typeof r === "string" ? r : r.address).toLowerCase());
  const ok = settings !== null && addresses.length === 1 && addresses[0] === signInOf(settings);
  return ok ? { kind: "ok" } : { kind: "block", reason: "probe_recipient", detail: "a Mailbox check may only go to the Mailbox's own sign-in address" };
};

/** Hold reasons a provider gives when it won't take the probe; probing then waits a day. */
const PROVIDER_REFUSALS = new Set(["provider_rejected", "provider_refused_permanently", "provider_limit"]);

export type FinishDeps = {
  ledger: () => Pick<Ledger, "getAction" | "resumeHeldBy">;
  probeFor: ProbeFor;
  /** Runs a plugin query with the Mailbox's own credential, its answer checked by the host. */
  query: QueryOf<"mailbox.probe_read">;
  now?: () => Date;
};

/**
 * Moves a Mailbox's pending check on, once a minute with its reply poll: the probe was refused, it
 * arrived and is compared, or a day passed without it. A pass frees the cold mail it held.
 */
export function finishHeaderCheck(deps: FinishDeps) {
  const now = deps.now ?? (() => new Date());
  return async function finish(workspaceId: string, credentialId: string): Promise<HeaderCheck["state"] | null> {
    const at = now();
    const found = await inWorkspace(workspaceId, async (tx) => ({ check: await currentCheck(tx, credentialId), settings: await credentialSettings(tx, credentialId) }));
    const { check, settings } = found;
    if (!check || check.state !== "pending" || !check.probeActionId || !settings) return check?.state ?? null;
    if (settingsHash(settings) !== check.settingsHash) {
      await inWorkspace(workspaceId, (tx) =>
        startCheck(tx, { workspaceId, credentialId, probeActionId: null, probeSubject: null, settingsHash: settingsHash(settings), state: "unchecked", reason: "settings_changed", createdBy: check.createdBy, createdAt: at }),
      );
      return "unchecked";
    }
    const settle = (state: "passed" | "replies_only" | "failed" | "inconclusive", more: { failures?: string[]; warnings?: string[]; reason?: string | null } = {}) =>
      inWorkspace(workspaceId, (tx) => settleCheck(tx, { credentialId, probeActionId: check.probeActionId!, settingsHash: check.settingsHash, state, ...more, settledAt: at }));

    const action = await deps.ledger().getAction(workspaceId, check.probeActionId);
    if (!action) return "pending";
    const refusal = action.blockReason ?? (action.state === "held" ? action.holdReason : null);
    if (refusal && PROVIDER_REFUSALS.has(refusal)) return (await settle("failed", { reason: "provider_refused" })) ? "failed" : "pending";
    if (action.state === "blocked" || action.state === "cancelled") return (await settle("failed", { reason: action.blockReason ?? action.state })) ? "failed" : "pending";

    // Sent, or sent as far as anyone can tell: look for it where it should have landed.
    if (action.state === "sent" || action.holdReason === "outcome_unknown") {
      const probe = await deps.probeFor(workspaceId, credentialId);
      // A pending check always has its probe's subject; one without can't be found by it.
      const read = probe && check.probeSubject ? await deps.query(workspaceId, probe.read, { actionId: action.id, subject: check.probeSubject }, credentialId) : { found: false as const };
      if (read.found) {
        const { text = "", listUnsubscribe } = storedSpec("mailbox.probe", action.spec);
        const footer = text.slice(text.indexOf("\n\n--\n") + 2);
        const v = compareProbe({ unsubscribeUrl: listUnsubscribe ?? null, text, footer, messageId: `<${action.id}@` }, read);
        const settled = await settle(v.state, { failures: v.failures, warnings: v.warnings });
        if (settled && v.state === "passed") {
          await deps.ledger().resumeHeldBy(workspaceId, "mailbox_unchecked", { system: "outreach" }, async (_tx, held) => held.credentialId === credentialId);
        }
        return settled ? v.state : "pending";
      }
    }
    if (at.getTime() - check.createdAt.getTime() >= DAY_MS) return (await settle("inconclusive", { reason: "probe_not_found" })) ? "inconclusive" : "pending";
    return "pending";
  };
}

/**
 * Why cold or marketing mail can't go from this Mailbox yet, or null when its current check passed
 * for its current settings. A Mailbox never checked counts as unchecked.
 */
export async function mailboxHold(tx: OutreachTx, credentialId: string | null): Promise<"mailbox_unchecked" | "mailbox_replies_only" | null> {
  if (!credentialId) return "mailbox_unchecked";
  const check = await currentCheck(tx, credentialId);
  const settings = await credentialSettings(tx, credentialId);
  if (!check || !settings || check.settingsHash !== settingsHash(settings)) return "mailbox_unchecked";
  if (check.state === "passed") return null;
  return check.state === "replies_only" ? "mailbox_replies_only" : "mailbox_unchecked";
}

/**
 * Each Mailbox's current check as a screen shows it. A check made with other settings counts as none,
 * and a Mailbox missing here was never checked.
 */
export const mailboxChecks = (workspaceId: string) =>
  inWorkspace(workspaceId, async (tx) => {
    const out = [];
    for (const c of await currentChecks(tx)) {
      const settings = await credentialSettings(tx, c.credentialId);
      if (!settings) continue;
      const stale = c.settingsHash !== settingsHash(settings);
      out.push({
        credentialId: c.credentialId,
        state: stale ? "unchecked" : c.state,
        reason: stale ? "settings_changed" : c.reason,
        failures: stale ? [] : c.failures,
        warnings: stale ? [] : c.warnings,
        checkedAt: (c.settledAt ?? c.createdAt).toISOString(),
      });
    }
    return out;
  });
