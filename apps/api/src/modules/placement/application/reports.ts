// SPDX-License-Identifier: AGPL-3.0-only
// Placement reports. Once a day each receiving Mailbox with a live yes sends every sender it read
// checks from one placement.report Action, to that sender's own address: the kind, verdict and
// Message-ID of each check it read (none for a check not found), each signed with its member key,
// and nothing else from the mailbox. A check found without a Message-ID, or whose read failed, has
// nothing the sender could match and is left out. The rows it reported name the report's Action, so
// the receiver can always see what it sent.
// On the sender's side, inbound routing hands a report here, and an entry counts only when Google's
// receiving server saw a DKIM pass for the From domain, From is the listed receiver, and the entry's
// signature is that member's; then either its Message-ID is one this Mailbox read back after sending
// a check of that kind it did not skip, or it says missing and names the day, receiver and kind of the
// one check this Mailbox really sent. Each check counts once. A check the sender never sent, such as
// a content check the receiver expected without a yes behind it, has no sent row and never counts.
// Nothing here logs: addresses, pairings and reports stay in the Workspace's own rows.
import { credentialSettings } from "../../credentials/index";
import type { Ledger, SnapshotEntry } from "../../ledger/index";
import type { Deployment } from "../../models/index";
import { lockMailboxDay, PROVIDER_CEILING } from "../../schedule/index";
import type { CatalogueEvent } from "../../plugins/index";
import { checksMade, countReported, inWorkspace, listState, recordReport, reportKey, reportsMade, unreported, type PlacementTx } from "../adapters/repo";
import type { UnsignedList } from "../domain/list";
import { REPORT_ENTRIES, REPORT_SUBJECT, reportSigned, reportText, type Report } from "../domain/report";
import type { Placement } from "./grant";
import type { JoinFor, MemberKeys } from "./join";
import { trustList, verifySignature } from "./list";
import { seed } from "./pairing";
import { approvePlacement, DAILY_CAP, type NotToday } from "./send";

/** What a report's routing reads of the event: From and Google's verdict on its signatures, never more. */
const norm = (a: string) => a.trim().toLowerCase();
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/** The one address in a From header, or null when it names none or more than one. */
export function fromAddress(from: string): string | null {
  const found = from.match(/[^\s<>,;:"()]+@[^\s<>,;:"()]+/g) ?? [];
  return found.length === 1 ? norm(found[0]!) : null;
}

/**
 * Whether the topmost Authentication-Results, which Gmail's receiving server writes above any the
 * mail arrived with, is Google's and records a DKIM pass signed by exactly this domain.
 */
export function dkimPasses(authenticationResults: string | undefined, domain: string): boolean {
  const [authserv, ...results] = (authenticationResults ?? "").replace(/\([^()]*\)/g, " ").split(";");
  if (authserv?.trim().toLowerCase() !== "mx.google.com") return false;
  return results.some((r) => {
    const method = /^\s*dkim\s*=\s*(\S+)/i.exec(r);
    if (method?.[1]?.toLowerCase() !== "pass") return false;
    const d = /\bheader\.d\s*=\s*([^\s;]+)/i.exec(r)?.[1] ?? /\bheader\.i\s*=\s*[^\s@;]*@([^\s;]+)/i.exec(r)?.[1];
    return !!d && norm(d) === domain;
  });
}

/**
 * Counts what a report carries for the Mailbox it reached, and returns how many entries counted.
 * Anything that fails a check counts nothing; the mail is still placement mail.
 */
export async function countReport(tx: PlacementTx, e: CatalogueEvent<"email.received">, report: Report, at: Date): Promise<number> {
  if (!e.credentialId) return 0;
  const { headers } = e.data;
  const from = fromAddress(headers.from);
  if (!from || from !== report.receiver) return 0;
  if (!dkimPasses(headers.authenticationResults, domainOf(from))) return 0;
  const list = (await listState(tx))?.list as UnsignedList | undefined;
  const reporter = list?.members.find((x) => x.address === from);
  if (!reporter) return 0;
  const settings = await credentialSettings(tx, e.credentialId);
  if (!settings || norm(String(settings.meta.username ?? settings.key)) !== report.sender) return 0;
  let counted = 0;
  for (const entry of report.entries) {
    if (!verifySignature(reporter.key, reportSigned({ ...entry, sender: report.sender, receiver: report.receiver }), entry.sig)) continue;
    if (await countReported(tx, e.credentialId, from, entry, at)) counted++;
  }
  return counted;
}

export type ReportedToday = { ok: true; made: number } | { ok: false; reason: NotToday };

export function createReporting(deps: {
  placement: Pick<Placement, "binding">;
  ledger: () => Pick<Ledger, "createActionIn" | "submitForApproval" | "approve" | "getAction">;
  reportFor: JoinFor;
  memberKeys: () => Pick<MemberKeys, "sign">;
  deployment: () => Deployment;
  trust?: (workspaceId: string) => ReturnType<typeof trustList>;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  const trust = deps.trust ?? ((workspaceId: string) => trustList(workspaceId));

  return {
    /** Today's reports from this Mailbox, one per sender it has unreported verdicts for; a rerun the same day makes nothing new. */
    async daily(workspaceId: string, credentialId: string): Promise<ReportedToday> {
      const at = now();
      const off = (reason: NotToday) => ({ ok: false as const, reason });
      if (deps.deployment() === "cloud") return off("not_available");
      // The live grant is checked before the member key signs anything.
      const grant = await deps.placement.binding(workspaceId, credentialId);
      if (!grant) return off("not_granted");
      const effect = await deps.reportFor(workspaceId, credentialId);
      if (!effect) return off("provider_cannot_send");
      const list = await trust(workspaceId);
      if (!list.ok) return off("no_list");
      const { settings, rows } = await inWorkspace(workspaceId, async (tx) => ({ settings: await credentialSettings(tx, credentialId), rows: await unreported(tx, credentialId) }));
      const me = norm(String(settings?.meta.username ?? settings?.key ?? ""));
      const members = new Set(list.trusted.list.members.map((x) => x.address));
      if (!members.has(me)) return off("not_listed");
      const day = seed(at, list.trusted.contentHash).day;

      const bySender = new Map<string, typeof rows>();
      // A member removed since stops getting reports.
      for (const r of rows) if (members.has(r.peer)) bySender.set(r.peer, [...(bySender.get(r.peer) ?? []), r]);
      let made = 0;
      for (const [sender, all] of bySender) {
        const carried = all.slice(0, REPORT_ENTRIES);
        const entries = [];
        for (const r of carried) {
          const fields = { list_version: r.listVersion, day: r.day, sender, receiver: me, kind: r.kind, message_id: r.verdict === "missing" ? null : r.messageId, verdict: r.verdict! };
          entries.push({ ...fields, sig: await deps.memberKeys().sign(workspaceId, credentialId, Buffer.from(reportSigned(fields))) });
        }
        const { spec } = await effect.prepare(workspaceId, { to: [sender], subject: REPORT_SUBJECT, text: reportText(sender, me, entries) });
        const actionId = await inWorkspace(workspaceId, async (tx) => {
          const emails = await lockMailboxDay(tx, credentialId, at, at);
          const reports = await reportsMade(tx, credentialId, day);
          // The rest wait for tomorrow's report.
          if (reports >= DAILY_CAP || emails + (await checksMade(tx, credentialId, { day })) + reports >= PROVIDER_CEILING) return null;
          const { action, created } = await deps.ledger().createActionIn(tx, workspaceId, { idempotencyKey: reportKey(credentialId, day, sender), capability: effect.id, dedupe: effect.dedupe, spec, credentialId, actor: { system: "placement" } });
          // A report already made today for this sender keeps its own rows, and these wait for tomorrow.
          if (created)
            await recordReport(
              tx,
              carried.map((r) => r.id),
              action.id,
            );
          return action.id;
        });
        if (!actionId) continue;
        const snapshot: SnapshotEntry[] = [...grant.snapshot, ...(effect.version ? [{ kind: "capability", id: effect.id, version: effect.version }] : [])];
        if (await approvePlacement(deps.ledger(), workspaceId, actionId, grant.approverId, snapshot)) made++;
      }
      return { ok: true, made };
    },
  };
}
export type Reporting = ReturnType<typeof createReporting>;
