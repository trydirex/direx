// SPDX-License-Identifier: AGPL-3.0-only
// Verification of an accepted company, in a background job after the approval: each kept published
// address is checked, then addresses are guessed for named people with none, and a guess is kept only
// when it verifies deliverable. Only `deliverable` is ever sendable; a missing check is `unknown`. A
// refused check (no checks left, a refused key, no answer) stores nothing and stops the company, so
// "Check again" can finish it; a stored `unknown` is asked again, which the vendor doesn't charge for.
// Every check is stored with its time and its cost on the run that found the company.
import { verifyAddressOutput, type QueryInput, type VerificationResult, type VerifyAddressOutput } from "@direx/plugin-sdk";
import type { QueryId } from "../../plugins/index";
import { beforePaidCheck } from "../adapters/mail-records";
import { inWorkspace } from "../adapters/repo";
import type { CompanyVerify } from "../adapters/queue";
import { companyEvidence, companyToVerify, keptAddresses, recordCheck, recordGuess } from "../adapters/verify-repo";
import { domainOf } from "../domain/domains";
import { afterGuess, fullName, guessesFor, mayGuessIn, peopleToGuess } from "../domain/guesses";
import { doNotEmailNotice } from "../domain/notice";

/** One paid check of one address. Null when the Workspace has no verification connected. */
export type VerifyAddress = (workspaceId: string, email: string) => Promise<VerifyAddressOutput | null>;
/** A plugin query, as the plugins module runs it through one credential. */
export type VerifyQuery = (workspaceId: string, capability: QueryId<"email.verify">, input: QueryInput<"email.verify">, credentialId: string) => Promise<unknown>;

/** A result older than this is checked again before hand-over. */
export const VERIFIED_FOR_DAYS = 30;
const DAY_MS = 86_400_000;

/** The composition root's VerifyAddress: the Workspace's verification credential, and a plugin answer that isn't trusted until parsed. */
export function verifyThrough(d: { query: VerifyQuery; capability: QueryId<"email.verify">; credentialFor: (workspaceId: string) => Promise<string | null> }): VerifyAddress {
  return async (workspaceId, email) => {
    const credentialId = await d.credentialFor(workspaceId);
    if (!credentialId) return null;
    return verifyAddressOutput.parse(await d.query(workspaceId, d.capability, { email }, credentialId));
  };
}

type Check = { refused: true } | { refused: false; result: VerificationResult; costMicros: number; connected: boolean };
export type VerifyOutcome = { status: "done" | "not_accepted" | "not_connected" | "refused"; checked: number; guessesKept: number };

/** Null and a stored unknown both still need an answer. */
const unanswered = (result: string | null | undefined) => !result || result === "unknown";

type ResolveMx = Parameters<typeof beforePaidCheck>[1];

export function createVerifier(deps: { verify: VerifyAddress; now?: () => Date; resolveMx?: ResolveMx; log?: (line: string) => void }) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.warn(line));

  async function checkOnce(workspaceId: string, email: string): Promise<Check> {
    const free = await beforePaidCheck(email, deps.resolveMx);
    if (free) return { refused: false, result: free, costMicros: 0, connected: true };
    let out: VerifyAddressOutput | null;
    try {
      out = await deps.verify(workspaceId, email);
    } catch (e) {
      // The message may carry the address or the vendor's words, so only the kind of failure is logged.
      log(`prospecting: a verification call was refused (${(e as Error).name}), so nothing is stored`);
      return { refused: true };
    }
    return out ? { refused: false, result: out.result, costMicros: out.costMicros, connected: true } : { refused: false, result: "unknown", costMicros: 0, connected: false };
  }

  /** An unknown is asked once more: the vendor doesn't charge for one, and it is often a passing failure. */
  async function check(workspaceId: string, email: string): Promise<Check> {
    const first = await checkOnce(workspaceId, email);
    if (first.refused || first.result !== "unknown" || !first.connected) return first;
    const again = await checkOnce(workspaceId, email);
    return again.refused ? again : { ...again, costMicros: first.costMicros + again.costMicros };
  }

  async function verifyCompany({ workspaceId, companyId }: CompanyVerify): Promise<VerifyOutcome> {
    const company = await inWorkspace(workspaceId, (tx) => companyToVerify(tx, companyId));
    // Nothing is paid for on a company a person didn't accept.
    if (company?.state !== "accepted") return { status: "not_accepted", checked: 0, guessesKept: 0 };
    const { runId, domain } = company;
    const ev = await inWorkspace(workspaceId, (tx) => companyEvidence(tx, companyId));
    let checked = 0;
    let guessesKept = 0;
    let connected = true;
    const refused = (): VerifyOutcome => ({ status: "refused", checked, guessesKept });
    for (const a of ev.addresses) {
      if (a.source !== "published" || a.leftOutReason !== null || !unanswered(a.verificationResult)) continue;
      const c = await check(workspaceId, a.email);
      if (c.refused) return refused();
      connected &&= c.connected;
      await inWorkspace(workspaceId, (tx) => recordCheck(tx, { addressId: a.id, runId, result: c.result, costMicros: c.costMicros, at: now() }));
      a.verificationResult = c.result;
      checked++;
    }
    const notConnected = (): VerifyOutcome => {
      log(`prospecting: company ${companyId} has no verification connected, so its addresses stay unknown and none are guessed`);
      return { status: "not_connected", checked, guessesKept: 0 };
    };
    if (!connected) return notConnected();

    const people = peopleToGuess(ev.people, ev.addresses);
    if (!people.length || !ev.pages.length) return { status: "done", checked, guessesKept: 0 };

    const byEmail = new Map(ev.addresses.map((a) => [a.email, a]));
    const noticeFound = ev.addresses.some((a) => a.noticeFound) || ev.pages.some((p) => doNotEmailNotice(p.text) !== null);
    // Recorded as a guess not tried, so the reason shows beside the person and a retry doesn't try it.
    const notTried = !mayGuessIn(company.country) ? "country_ca" : noticeFound ? "do_not_email_notice" : null;
    let domainDone = ev.addresses.some((a) => a.verificationResult === "catch_all" && domainOf(a.email) === domain);

    for (const p of people) {
      const name = fullName(p);
      const guesses = guessesFor(p.first, p.last, domain);
      // The page that names the person is the guess's evidence.
      const page = ev.pages.find((pg) => pg.text.toLowerCase().includes(name.toLowerCase())) ?? ev.pages[0]!;
      const row = (g: (typeof guesses)[number], leftOutReason: string | null, verificationResult: string | null) => ({
        workspaceId,
        companyId,
        email: g.email,
        pattern: g.pattern,
        name,
        role: p.role,
        snapshotId: page.id,
        readAt: page.readAt,
        noticeFound,
        leftOutReason,
        verificationResult,
      });
      if (!guesses.length || domainDone) continue;
      if (notTried) {
        await inWorkspace(workspaceId, (tx) => recordGuess(tx, row(guesses[0]!, notTried, null), { runId, costMicros: 0, at: now() }));
        continue;
      }
      for (const g of guesses) {
        const known = byEmail.get(g.email);
        // Someone else's published address, or a guess recorded as not tried, ends this person's guessing.
        if (known && (known.source === "published" || known.verificationResult === null)) break;
        let result = known?.verificationResult ?? "";
        if (unanswered(result)) {
          const c = await check(workspaceId, g.email);
          if (c.refused) return refused();
          if (!c.connected) return notConnected();
          result = c.result;
          const kept = result === "deliverable";
          await inWorkspace(workspaceId, (tx) => recordGuess(tx, row(g, kept ? null : "not_deliverable", c.result), { runId, costMicros: c.costMicros, at: now() }));
          checked++;
          if (kept) guessesKept++;
        }
        const next = afterGuess(result);
        if (next === "stop_domain") domainDone = true;
        if (next !== "next") break;
      }
    }
    return { status: "done", checked, guessesKept };
  }

  /**
   * The current result of each kept address of an accepted company among `addressIds`, checking again
   * any that is unknown or older than 30 days first. An id missing from the answer isn't sendable.
   */
  async function freshResults(workspaceId: string, addressIds: string[]): Promise<Map<string, VerificationResult>> {
    const rows = await inWorkspace(workspaceId, (tx) => keptAddresses(tx, addressIds));
    const out = new Map<string, VerificationResult>();
    for (const r of rows) {
      const fresh = r.result !== null && r.result !== "unknown" && r.verifiedAt !== null && now().getTime() - r.verifiedAt.getTime() <= VERIFIED_FOR_DAYS * DAY_MS;
      if (fresh) {
        out.set(r.id, r.result as VerificationResult);
        continue;
      }
      const c = await check(workspaceId, r.email);
      // A refused check isn't an answer: the address stays as it was and isn't sendable now.
      if (c.refused) continue;
      await inWorkspace(workspaceId, (tx) => recordCheck(tx, { addressId: r.id, runId: r.runId, result: c.result, costMicros: c.costMicros, at: now() }));
      out.set(r.id, c.result);
    }
    return out;
  }

  return { verifyCompany, freshResults };
}

export type Verifier = ReturnType<typeof createVerifier>;
