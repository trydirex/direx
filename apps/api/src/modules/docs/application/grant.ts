// SPDX-License-Identifier: AGPL-3.0-only
// Status write-back's grant (ADR 0025), copied from Placement's. Someone with rule.grant answers yes
// or no for one imported source, after reading what is written and that everyone using the database
// sees it; no answer is no. The yes binds the source's credential and a hash of its write-back
// mapping, so a new mapping, a new credential, new words or the granter losing rule.grant ends it.
// Any member stops it with a reason, which cancels the source's write-backs not yet out. Every
// write-back is approved in the granter's name and binds the grant, checked at claim and dispatch.
import { createHash } from "node:crypto";
import { storedSpec } from "@direx/plugin-sdk/host";
import { z } from "zod";
import { approverFromMember, can, mayGrantRules, type Role } from "../../identity/index";
import type { Actor, ApproverId, Check, Ledger, LedgerTx, Resolver, SnapshotEntry } from "../../ledger/index";
import { clearEndedWrites, currentGrant, grantById, inWorkspace, insertGrant, lockSource, rowByKey, rowsWithWrites, saveWriteBack, sourceById, sources, stopGrant, type DocsTx, type GrantRow, type SourceRow } from "../adapters/repo";
import { canonical, writeBackProblem, type WriteBack } from "../domain/write-back";
import { reader, type ReadDeps } from "./read";

/** Bumped whenever the words below change; a yes given on older words pauses write-back until answered again. */
export const DOCS_WRITE_WORDING_VERSION = "2026-11-14";
/** Shown right before the yes or no, with neither chosen. */
export const DOCS_WRITE_WORDING = [
  "Let Direx update these rows' status in your docs tool? If you say yes, each row Direx imported from this database shows its post's state: Scheduled, Sent or Cancelled, with the post's link once it is sent.",
  "What Direx writes: only the status column and the link column you picked, by their ids. It writes over a status Direx wrote or an empty one, never over a status a person set.",
  "Writes reach everyone who uses this database.",
  "Any member of this Workspace can stop it at any time. Not answering means no.",
].join("\n\n");
/** The snapshot kind a write-back's approval binds. */
export const DOC_WRITE_GRANT_KIND = "doc_write_grant";
/** Prefix of a write-back's idempotency key: source, row and generation follow (rule 006). */
export const WRITE_KEY = "docs_write";

const optionId = z.string().min(1).max(200);
export const WriteBackInput = z.strictObject({
  statusPropertyId: optionId,
  statusType: z.enum(["status", "select"]),
  options: z.strictObject({ scheduled: optionId.optional(), sent: optionId.optional(), cancelled: optionId.optional() }).refine((o) => Object.values(o).some(Boolean), "map at least one state"),
  urlPropertyId: optionId.optional(),
});
/** The hash a grant binds: sha256 of the write-back mapping's canonical JSON. */
export const mappingHash = (w: unknown) => createHash("sha256").update(canonical(w)).digest("hex");

export const isDocsWrite = (capability: string) => capability.endsWith("/docs.row.update");
export const versionOf = (g: Pick<GrantRow, "answeredBy" | "wordingVersion" | "mappingHash">) => `${g.answeredBy}:${g.wordingVersion}:${g.mappingHash}`;
const isYesUnstopped = (g: GrantRow | undefined): g is GrantRow => g?.answer === "yes" && !g.stoppedAt;

/** The grant a source's writes run under now: its newest answer, a yes on today's words, for its mapping and credential, from someone who still holds rule.grant. */
export async function liveGrant(tx: DocsTx, source: SourceRow): Promise<GrantRow | null> {
  const g = await currentGrant(tx, source.id);
  const fits = isYesUnstopped(g) && g.wordingVersion === DOCS_WRITE_WORDING_VERSION && source.writeBack != null && g.mappingHash === mappingHash(source.writeBack) && g.credentialId === source.credentialId;
  return fits && (await mayGrantRules(tx, g.answeredBy)) ? g : null;
}

/** The live version of a bound grant; null once it is stopped or replaced, or no longer fits its source. */
export const docWriteGrantVersion: Resolver = async (tx, id) => {
  const g = await grantById(tx, id);
  const source = g && (await sourceById(tx, g.sourceId));
  const live = source ? await liveGrant(tx, source) : null;
  return live?.id === id ? versionOf(live) : null;
};

type Cancel = Pick<Ledger, "cancelPendingByIds">;

/**
 * Stops the source's yes and cancels its write-backs not yet out, in the caller's transaction. The
 * Actions are locked before the source and its grant, in the Dispatcher's order. A write that may
 * have gone out stays for reconcile; it is never resent.
 */
export async function stopIn(tx: DocsTx, ledger: Cancel, sourceId: string, s: { stoppedBy: string | null; reason: string; at: Date }) {
  const actor: Actor = s.stoppedBy ? { userId: s.stoppedBy } : { system: "docs" };
  const ids = (await rowsWithWrites(tx, sourceId)).flatMap((r) => (r.action ? [r.action.id] : []));
  const cancelled = await ledger.cancelPendingByIds(tx, ids, actor);
  const g = await currentGrant(tx, sourceId);
  const stopped = isYesUnstopped(g) ? await stopGrant(tx, g.id, { stoppedBy: s.stoppedBy, stoppedAt: s.at, stopReason: s.reason }) : undefined;
  // The next yes writes each row's state again, rather than leaving what this one couldn't.
  await clearEndedWrites(tx, sourceId);
  return { stopped, cancelled };
}

/** A write-back's source, row and generation, read from its idempotency key. */
export function writeKeyOf(key: string): { sourceId: string; externalId: string; generation: number } | null {
  const m = new RegExp(`^${WRITE_KEY}:([0-9a-f-]{36}):(.+):(\\d+)$`).exec(key);
  return m ? { sourceId: m[1]!, externalId: m[2]!, generation: Number(m[3]) } : null;
}

/**
 * At claim and at dispatch, under the source row's lock: a write-back goes out only while it is its
 * row's newest generation (rule 006), under the source's live grant in its approver's name (rule 002),
 * writing an option the mapping still has (rule 003).
 */
export const docWriteCurrent: Check = async (tx: LedgerTx, action, approval) => {
  if (!isDocsWrite(action.capability)) return { kind: "ok" };
  const key = writeKeyOf(action.idempotencyKey);
  const row = key && (await rowByKey(tx, key.sourceId, key.externalId));
  if (!key || !row || row.writeActionId !== action.id || row.generation !== key.generation) return { kind: "block", reason: "superseded", detail: "a newer status write-back for this row replaced it" };
  const source = await lockSource(tx, key.sourceId, "share");
  const g = source ? await liveGrant(tx, source) : null;
  if (!source || !g || g.answeredBy !== approval.approverId) return { kind: "hold", reason: "docs_write_not_granted", detail: "this source has no live yes to status write-back from its approver" };
  const { optionId } = storedSpec("docs.row.update", action.spec);
  if (optionId === undefined || !Object.values((source.writeBack as WriteBack).options).includes(optionId)) return { kind: "block", reason: "option_gone", detail: "the write-back mapping no longer has this option" };
  return { kind: "ok" };
};

export type WriteStatus = "unanswered" | "no" | "on" | "stopped" | "wording_changed" | "mapping_changed" | "granter_lost";
type Member = { userId: string; role: Role };

async function stateIn(tx: DocsTx, source: SourceRow, member: Member) {
  const g = await currentGrant(tx, source.id);
  const status: WriteStatus = !g
    ? "unanswered"
    : g.answer === "no"
      ? "no"
      : g.stoppedAt
        ? "stopped"
        : g.wordingVersion !== DOCS_WRITE_WORDING_VERSION
          ? "wording_changed"
          : g.mappingHash !== mappingHash(source.writeBack) || g.credentialId !== source.credentialId
            ? "mapping_changed"
            : (await mayGrantRules(tx, g.answeredBy))
              ? "on"
              : "granter_lost";
  // Held and Blocked write-backs show here, never in Needs you (rule 007).
  const writes = (await rowsWithWrites(tx, source.id)).flatMap(({ row, action: a }) =>
    a && (a.state === "held" || a.state === "blocked") ? [{ rowId: row.externalId, itemId: row.itemId, state: a.state, reason: (a.holdReason ?? a.blockReason)!, detail: a.reasonDetail }] : [],
  );
  return {
    status,
    wordingVersion: DOCS_WRITE_WORDING_VERSION,
    wording: DOCS_WRITE_WORDING,
    mayAnswer: can(member.role, "rule.grant"),
    writeBack: (source.writeBack as WriteBack | null) ?? null,
    grant: g ? { id: g.id, answer: g.answer as "yes" | "no", wordingVersion: g.wordingVersion, answeredBy: g.answeredBy, answeredAt: g.answeredAt, stoppedBy: g.stoppedBy, stoppedAt: g.stoppedAt, stopReason: g.stopReason } : null,
    writes,
  };
}
export type WriteBackState = Awaited<ReturnType<typeof stateIn>>;

export type GrantDeps = ReadDeps & {
  ledger: () => Cancel;
  /** A new yes: write each row's state once, soon (rule 006). After the answer commits. */
  onGranted?: (workspaceId: string, sourceId: string) => Promise<void>;
  now?: () => Date;
};

export function createWriteBackGrants(deps: GrantDeps) {
  const now = deps.now ?? (() => new Date());
  const { connection, ask } = reader(deps);

  type Refusal = "not_found" | "stale_wording" | "no_write_back" | "already_on" | "not_on";
  type Out = { ok: true; state: WriteBackState } | { ok: false; reason: Refusal };

  return {
    async state(workspaceId: string, sourceId: string, member: Member): Promise<Out> {
      return inWorkspace(workspaceId, async (tx): Promise<Out> => {
        const source = await sourceById(tx, sourceId);
        return source ? { ok: true, state: await stateIn(tx, source, member) } : { ok: false, reason: "not_found" };
      });
    },

    /** Every imported source with where its write-back stands, from the database only, so any member can reach Stop. */
    async list(workspaceId: string, member: Member) {
      return inWorkspace(workspaceId, async (tx) => {
        const out = [];
        for (const s of await sources(tx)) out.push({ id: s.id, title: s.title, state: await stateIn(tx, s, member) });
        return out;
      });
    },

    /**
     * Saves which column and options a source's status writes to, checked against the database, with
     * the connection's credential. A change stops the source's yes until someone answers again.
     */
    async saveWriteBack(workspaceId: string, sourceId: string, w: WriteBack) {
      const c = await connection(workspaceId);
      if (!c) return { ok: false, reason: "not_connected" } as const;
      if (!c.provider.rows || !c.provider.write) return { ok: false, reason: "no_write_back" } as const;
      const source = await inWorkspace(workspaceId, (tx) => sourceById(tx, sourceId));
      if (!source) return { ok: false, reason: "not_found" } as const;
      const read = await ask(workspaceId, c, c.provider.rows, { sourceId: source.externalId });
      if (!read.ok) return read;
      const problem = writeBackProblem(w, read.out.columns);
      if (problem) return { ok: false, reason: problem } as const;
      const at = now();
      await inWorkspace(workspaceId, async (tx) => {
        const changed = mappingHash(w) !== (source.writeBack ? mappingHash(source.writeBack) : null) || c.credentialId !== source.credentialId;
        if (!changed) return;
        await stopIn(tx, deps.ledger(), sourceId, { stoppedBy: null, reason: "mapping_changed", at });
        await saveWriteBack(tx, sourceId, { credentialId: c.credentialId, writeBack: w, now: at });
      });
      return { ok: true } as const;
    },

    /** Records a yes or a no from someone with rule.grant (the route checks it), for the mapping saved now. */
    async answer(workspaceId: string, sourceId: string, member: Member, a: { answer: "yes" | "no"; wordingVersion: string }): Promise<Out> {
      if (a.wordingVersion !== DOCS_WRITE_WORDING_VERSION) return { ok: false, reason: "stale_wording" };
      const r = await inWorkspace(workspaceId, async (tx): Promise<Out> => {
        const source = await sourceById(tx, sourceId);
        if (!source) return { ok: false, reason: "not_found" };
        if (!source.writeBack || !source.credentialId) return { ok: false, reason: "no_write_back" };
        // A live yes is turned off by stopping it, which also cancels what it would write.
        if ((await stateIn(tx, source, member)).status === "on") return { ok: false, reason: "already_on" };
        await insertGrant(tx, { workspaceId, sourceId, credentialId: source.credentialId, mappingHash: mappingHash(source.writeBack), answer: a.answer, wordingVersion: DOCS_WRITE_WORDING_VERSION, answeredBy: member.userId, answeredAt: now() });
        return { ok: true, state: await stateIn(tx, source, member) };
      });
      if (r.ok && a.answer === "yes") await deps.onGranted?.(workspaceId, sourceId);
      return r;
    },

    /** Any member stops a yes in one action, with a reason; the source's write-backs not yet out are cancelled with it. */
    async stop(workspaceId: string, sourceId: string, member: Member, reason: string): Promise<{ ok: true; cancelled: number; state: WriteBackState } | { ok: false; reason: Refusal }> {
      return inWorkspace(workspaceId, async (tx) => {
        const source = await sourceById(tx, sourceId);
        if (!source) return { ok: false as const, reason: "not_found" as const };
        if (!isYesUnstopped(await currentGrant(tx, sourceId))) return { ok: false as const, reason: "not_on" as const };
        const { cancelled } = await stopIn(tx, deps.ledger(), sourceId, { stoppedBy: member.userId, reason, at: now() });
        return { ok: true as const, cancelled, state: await stateIn(tx, source, member) };
      });
    },
  };
}
export type WriteBackGrants = ReturnType<typeof createWriteBackGrants>;

/** What a write-back's approval binds: the source's live grant, in its granter's name. Null while there is none. */
export async function bindingIn(tx: DocsTx, source: SourceRow): Promise<{ grant: GrantRow; approverId: ApproverId; snapshot: SnapshotEntry[] } | null> {
  const g = await liveGrant(tx, source);
  return g && { grant: g, approverId: approverFromMember({ userId: g.answeredBy }), snapshot: [{ kind: DOC_WRITE_GRANT_KIND, id: g.id, version: versionOf(g) }] };
}
