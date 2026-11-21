// SPDX-License-Identifier: AGPL-3.0-only
// Tracked links in a Campaign step's message, fixed with its text before the hash (ADR 0035 rules 001,
// 002, 011 to 013). An email's links are made in their own short transaction, so no transaction waits on
// the Mailbox's plugin; a DM's in the transaction that makes the DM. Uses are written with the message.
// A link no use points at never redirects.
import { createHash, randomBytes } from "node:crypto";
import { campaignTracking, countryOf, destinationOf, inWorkspace, insertUses, linkDestination, linkFor, type TrackingTx, type UseTarget } from "../adapters/repo";
import { rewriteLinks } from "../domain/rewrite";

/** Which Campaign step a message belongs to; the Campaign says whether and where it tracks. */
export type TrackingInput = { campaignId: string; stepKey: string };
export type FixedLinks = { text: string; perRecipient: boolean; inputsHash: string; uses: { linkId: string; tokenHash: string | null; personId: string | null }[] };

/** Only a person's statement of the US makes a Person's links per-Person (rule 012). */
const PER_PERSON_COUNTRY = "US";
// A domain whose DNS is checked can get its certificate on the first click; one stopped makes no links.
const MAKES_LINKS = new Set(["dns_ok", "verified"]);
const TRACKED_PATH = /^\/t\/([A-Za-z0-9_-]{22})(?:\/[A-Za-z0-9_-]{43})?$/;
const RECIPIENT_PATH = /^\/t\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{43}$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");

/** The inputs a fixed draft's links depend on. A change before dispatch holds its Action (rule 015). */
export type TrackingInputs = { perPerson: boolean; marked: boolean; country: string | null; confidence: string | null; domainId: string };
export const inputsHash = (i: TrackingInputs) => sha256(JSON.stringify([i.perPerson, i.marked, i.country, i.confidence, i.domainId]));

/**
 * The message's text with each https link replaced by its step's tracked link, and the uses to record,
 * or null when the Campaign doesn't track links now, which leaves the text as written. With no Person
 * (a DM or a post, rule 012) or for a Placement check (`checkOnly`, rule 002), no link carries a token.
 */
export async function fixLinksIn(tx: TrackingTx, workspaceId: string, a: TrackingInput & { personId: string | null; text: string; now: Date; checkOnly?: boolean }): Promise<FixedLinks | null> {
  const t = await campaignTracking(tx, a.campaignId);
  if (!t?.trackingOn || !t.domainId || !t.hostname || !MAKES_LINKS.has(t.state!)) return null;
  const checkOnly = a.checkOnly ?? false;
  const who = a.personId && !checkOnly ? await countryOf(tx, a.personId) : undefined;
  // No Person can be marked "Don't count my clicks" until marks exist (spec §9), so none is.
  const inputs: TrackingInputs = { perPerson: t.perPersonOn, marked: false, country: who?.country ?? null, confidence: who?.confidence ?? null, domainId: t.domainId };
  const perPerson = a.personId !== null && !checkOnly && inputs.perPerson && !inputs.marked && inputs.country === PER_PERSON_COUNTRY && inputs.confidence === "stated";
  const urls = new Map<string, string>();
  const fixedDestinations = new Map<string, string>();
  const uses: FixedLinks["uses"] = [];
  for (const source of rewriteLinks(a.text, () => null).destinations) {
    const url = new URL(source);
    let destination = source;
    if (url.hostname === t.hostname) {
      // Ordinary drafts keep existing links. A probe must go straight to the destination
      // to avoid counting against the original link or including its recipient token.
      const id = checkOnly ? TRACKED_PATH.exec(url.pathname)?.[1] : undefined;
      if (!id) continue;
      const original = await linkDestination(tx, t.domainId, id);
      if (!original) continue;
      destination = original;
    }
    let fixed = fixedDestinations.get(destination);
    if (!fixed) {
      const linkId = await linkFor(tx, { id: randomBytes(16).toString("base64url"), workspaceId, campaignId: a.campaignId, stepKey: a.stepKey, domainId: t.domainId, destination, checkOnly, now: a.now });
      const secret = perPerson ? token() : null;
      fixed = `https://${t.hostname}/t/${linkId}${secret ? `/${secret}` : ""}`;
      fixedDestinations.set(destination, fixed);
      uses.push({ linkId, tokenHash: secret && sha256(secret), personId: secret && a.personId });
    }
    urls.set(source, fixed);
  }
  let perRecipient = false;
  const { text } = rewriteLinks(a.text, (destination) => {
    const replacement = urls.get(destination);
    const output = new URL(replacement ?? destination);
    if (output.hostname === t.hostname && RECIPIENT_PATH.test(output.pathname)) perRecipient = true;
    return replacement ?? null;
  });
  return { text, perRecipient, inputsHash: inputsHash(inputs), uses };
}

/** fixLinksIn in its own transaction, for an email whose plugin is asked next. */
export const fixLinks = (workspaceId: string, a: Parameters<typeof fixLinksIn>[2]) => inWorkspace(workspaceId, (tx) => fixLinksIn(tx, workspaceId, a));

/** Records the fixed links as used by the Item's Action, in the transaction that wrote it. */
export const recordUses = (tx: TrackingTx, workspaceId: string, itemId: string, fixed: FixedLinks, now: Date) => insertUses(tx, workspaceId, { itemId }, fixed.inputsHash, fixed.uses, now);

/** Records the fixed links as used by an Action or a DM, in the transaction that wrote it. */
export const recordUsesOf = (tx: TrackingTx, workspaceId: string, target: Exclude<UseTarget, { itemId: string }>, fixed: FixedLinks, now: Date) => insertUses(tx, workspaceId, target, fixed.inputsHash, fixed.uses, now);

/**
 * Where a tracked link of this Workspace goes, or the URL itself when it isn't one. A link card is read
 * from the destination, never through the redirect, which an unapproved post's link doesn't answer.
 */
export async function trackedDestination(workspaceId: string, url: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const linkId = TRACKED_PATH.exec(u.pathname)?.[1];
  if (u.protocol !== "https:" || !linkId) return url;
  return (await inWorkspace(workspaceId, (tx) => destinationOf(tx, u.hostname, linkId))) ?? url;
}
