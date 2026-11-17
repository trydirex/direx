// SPDX-License-Identifier: AGPL-3.0-only
// One review Item per company once its site is read and its names are settled. A person keeps some of
// its addresses, which ends Applied, or rejects the company, whose pages then expire. Everything on it
// came from the company's own pages, so it always carries a warning and is never approved in bulk.
import type { PgBoss } from "pg-boss";
import { warn, type ItemKind, type Items } from "../../items/index";
import { sentTo } from "../../ledger/index";
import { OPTED_OUT, whyNot } from "../../outreach/index";
import { emailsOfGroup, personIdWithEmail } from "../../people/index";
import { sendCompanyVerify } from "../adapters/queue";
import { acceptCompany, companyForReview, inWorkspace, linkReview, lockInReview, rejectCompany, reviewContent, unlinkedReview } from "../adapters/repo";
import type { AddressKind } from "../domain/addresses";
import { fullName, mayGuessIn, peopleToGuess } from "../domain/guesses";

export const REVIEW_KIND = "company_review";
export const REVIEW_WARNING = "Read from the company's own website, which Direx doesn't trust. Check each address and quote before keeping it.";
/** How long a rejected company's pages are kept before they may be deleted. */
export const REJECTED_KEEP_DAYS = 90;
export const REJECT = "reject";
const DAY_MS = 86_400_000;
const SYSTEM = { system: "prospecting" } as const;

export type ReviewAddress = {
  id: string;
  email: string;
  kind: AddressKind;
  source: string;
  name: string | null;
  role: string | null;
  pageUrl: string;
  snapshotId: string;
  readAt: string;
  /** The Person this address already belongs to; it joins them rather than making another. */
  personId: string | null;
  /** Why a person can't keep it. Null for an address they may keep. */
  leftOut: string | null;
};
export type ReviewPayload = {
  companyId: string;
  domain: string;
  website: string;
  name: string | null;
  country: { code: string; quote: string | null } | null;
  names: { status: string; reason: string | null };
  signals: { type: string; quote: string; pageUrl: string; observedOn: string }[];
  /** Addresses a person may keep come first, so the numbers in a choice stay short. */
  addresses: ReviewAddress[];
  /** People named on the site with no published address, whom accepting guesses and checks an address for. Absent on older Items. */
  guessFor?: { name: string; role: string | null }[];
};

/** Makes the company's review Item once both its read and its names are settled; null until then. */
export type OpenReview = (workspaceId: string, companyId: string) => Promise<string | null>;

/** Accepting with no address kept, which only guesses addresses for the people named. */
export const KEEP_NONE = "none";

/**
 * A choice is "reject", "none", or the positions in the Item's address list of the ones to keep, such as "0,2".
 * The list is fixed when the Item is made, so a position always means the address the person saw.
 */
export function readChoice(choice: string | undefined, addresses: readonly ReviewAddress[], guessFor: readonly unknown[] = []): { ok: true; reject: true } | { ok: true; reject: false; keep: number[] } | { ok: false; reason: string } {
  if (choice === REJECT) return { ok: true, reject: true };
  if (choice === KEEP_NONE) return guessFor.length ? { ok: true, reject: false, keep: [] } : { ok: false, reason: "nothing_to_keep" };
  if (!choice || !/^\d{1,3}(,\d{1,3})*$/.test(choice)) return { ok: false, reason: "choice_required" };
  const keep = [...new Set(choice.split(",").map(Number))];
  if (keep.some((i) => i >= addresses.length)) return { ok: false, reason: "unknown_address" };
  if (keep.some((i) => addresses[i]!.leftOut !== null)) return { ok: false, reason: "address_left_out" };
  return { ok: true, reject: false, keep };
}

/** Registered with items, so items never imports prospecting. */
export function prospectKinds(deps: { boss: PgBoss; now?: () => Date }): Record<string, ItemKind> {
  const now = deps.now ?? (() => new Date());
  return {
    [REVIEW_KIND]: {
      permission: "item.approve",
      // Dismissing would leave the company in review with no way out; a person rejects it instead.
      dismiss: false,
      async apply(tx, item, _actor, choice) {
        const p = item.payload as ReviewPayload;
        const decided = readChoice(choice, p.addresses, p.guessFor);
        if (!decided.ok) return decided;
        if (!(await lockInReview(tx, p.companyId, item.id))) return { ok: false, reason: "company_changed" };
        const at = now();
        if (decided.reject) {
          await rejectCompany(tx, p.companyId, new Date(at.getTime() + REJECTED_KEEP_DAYS * DAY_MS), at);
        } else {
          const notKept = p.addresses.flatMap((a, i) => (decided.keep.includes(i) ? [] : [{ id: a.id, reason: a.leftOut ?? "not_kept" }]));
          await acceptCompany(tx, p.companyId, notKept, at);
          // Checks call a vendor, so they run after the approval commits, and only over what was kept.
          await sendCompanyVerify(deps.boss, tx, { workspaceId: item.workspaceId, companyId: p.companyId }, at);
        }
        return { ok: true };
      },
    },
  };
}

// An address with no one known by it could be anyone's, so it isn't offered.
const storedLeftOut = (a: { kind: string; leftOutReason: string | null }) => a.leftOutReason ?? (a.kind === "named" || a.kind === "function" ? null : "no_known_person");

/** Who an address already is, and whether that Person opted out or was already written to. */
async function dedupe(workspaceId: string, emails: string[]) {
  const found = await inWorkspace(workspaceId, async (tx) => {
    const out = new Map<string, { personId: string; touched: boolean }>();
    for (const email of emails) {
      const personId = await personIdWithEmail(tx, email);
      if (!personId) continue;
      let touched = false;
      for (const e of await emailsOfGroup(tx, personId)) if (!touched && (await sentTo(tx, e))) touched = true;
      out.set(email, { personId, touched });
    }
    return out;
  });
  // Only an opt-out counts here: a missing basis is recorded at hand-over, not a reason to leave someone out.
  const why = await whyNot(workspaceId, [...new Set([...found.values()].map((f) => f.personId))], "cold");
  return new Map([...found].map(([email, f]) => [email, { personId: f.personId, leftOut: why.get(f.personId) === OPTED_OUT ? "opted_out" : f.touched ? "already_contacted" : null }]));
}

export function companyReviews(deps: { items: () => Items; now?: () => Date }): { open: OpenReview } {
  const now = deps.now ?? (() => new Date());

  async function open(workspaceId: string, companyId: string): Promise<string | null> {
    const found = await inWorkspace(workspaceId, async (tx) => {
      const c = await companyForReview(tx, companyId);
      // A site not read has nothing to review, and names still being read would change the addresses.
      if (!c || c.readStatus !== "read" || (c.namesStatus !== "done" && c.namesStatus !== "skipped")) return { done: true, itemId: null } as const;
      if (c.reviewItemId) return { done: true, itemId: c.reviewItemId } as const;
      const left = await unlinkedReview(tx, REVIEW_KIND, companyId);
      if (left) return { done: true, itemId: (await linkReview(tx, companyId, left, now())) ? left : (await companyForReview(tx, companyId))!.reviewItemId } as const;
      return { done: false, company: c, content: await reviewContent(tx, companyId) } as const;
    });
    if (found.done) return found.itemId;
    const { company: c, content } = found;

    const offered = content.addresses.filter((a) => storedLeftOut(a) === null).map((a) => a.email);
    const known = await dedupe(workspaceId, offered);
    const addresses: ReviewAddress[] = content.addresses
      .map((a) => ({
        id: a.id,
        email: a.email,
        kind: a.kind as AddressKind,
        source: a.source,
        name: a.name,
        role: a.role,
        pageUrl: a.pageUrl,
        snapshotId: a.snapshotId,
        readAt: a.readAt.toISOString(),
        personId: known.get(a.email)?.personId ?? null,
        leftOut: storedLeftOut(a) ?? known.get(a.email)?.leftOut ?? null,
      }))
      .sort((x, y) => Number(x.leftOut !== null) - Number(y.leftOut !== null));
    const payload: ReviewPayload = {
      companyId,
      domain: c.domain,
      website: c.website,
      name: c.name,
      country: c.country ? { code: c.country, quote: c.countryQuote } : null,
      names: { status: c.namesStatus!, reason: c.namesReason },
      signals: content.signals,
      addresses,
      guessFor: mayGuessIn(c.country) ? peopleToGuess(content.people, content.addresses).map((g) => ({ name: fullName(g), role: g.role })) : [],
    };
    const made = await deps.items().createItem(workspaceId, {
      kind: REVIEW_KIND,
      payload,
      actor: SYSTEM,
      details: { title: `Review ${c.name ?? c.domain}`, workArea: "prospecting", channel: "email", warnings: [warn("untrusted_source", REVIEW_WARNING)] },
    });
    if (!made.ok) throw new Error(`prospecting: ${made.reason}: the item kinds aren't registered`);
    if (await inWorkspace(workspaceId, (tx) => linkReview(tx, companyId, made.item.id, now()))) return made.item.id;
    // Another call made and linked its Item first; this one is withdrawn so the company keeps one.
    await deps.items().cancel(workspaceId, made.item.id, SYSTEM);
    return (await inWorkspace(workspaceId, (tx) => companyForReview(tx, companyId)))!.reviewItemId;
  }

  return { open };
}
