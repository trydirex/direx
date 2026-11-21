// SPDX-License-Identifier: AGPL-3.0-only
// Tracked links in a Campaign step's email, fixed with its text before the hash (ADR 0035 rules 001,
// 011 to 013). The links are made here, in their own short transaction, so no transaction waits on the
// Mailbox's plugin; the uses are written with the Action. A link no use points at never redirects.
import { createHash, randomBytes } from "node:crypto";
import { campaignTracking, countryOf, inWorkspace, insertUses, linkFor, type TrackingTx } from "../adapters/repo";
import { rewriteLinks } from "../domain/rewrite";

/** Which Campaign step an email belongs to; the Campaign says whether and where it tracks. */
export type TrackingInput = { campaignId: string; stepKey: string };
export type FixedLinks = { text: string; perRecipient: boolean; inputsHash: string; uses: { linkId: string; tokenHash: string | null; personId: string | null }[] };

/** Only a person's statement of the US makes a Person's links per-Person (rule 012). */
const PER_PERSON_COUNTRY = "US";
// A domain whose DNS is checked can get its certificate on the first click; one stopped makes no links.
const MAKES_LINKS = new Set(["dns_ok", "verified"]);
const RECIPIENT_PATH = /^\/t\/[A-Za-z0-9_-]{22}\/[A-Za-z0-9_-]{43}$/;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");

/** The inputs a fixed draft's links depend on. A change before dispatch holds its Action (rule 015). */
export type TrackingInputs = { perPerson: boolean; marked: boolean; country: string | null; confidence: string | null; domainId: string };
export const inputsHash = (i: TrackingInputs) => sha256(JSON.stringify([i.perPerson, i.marked, i.country, i.confidence, i.domainId]));

/**
 * The email's text with each https link replaced by its step's tracked link, and the uses to record,
 * or null when the Campaign doesn't track links now, which leaves the text as written.
 */
export function fixLinks(workspaceId: string, a: TrackingInput & { personId: string; text: string; now: Date }): Promise<FixedLinks | null> {
  return inWorkspace(workspaceId, async (tx) => {
    const t = await campaignTracking(tx, a.campaignId);
    if (!t?.trackingOn || !t.domainId || !t.hostname || !MAKES_LINKS.has(t.state!)) return null;
    const who = await countryOf(tx, a.personId);
    // No Person can be marked "Don't count my clicks" until marks exist (spec §9), so none is.
    const inputs: TrackingInputs = { perPerson: t.perPersonOn, marked: false, country: who?.country ?? null, confidence: who?.confidence ?? null, domainId: t.domainId };
    const perPerson = inputs.perPerson && !inputs.marked && inputs.country === PER_PERSON_COUNTRY && inputs.confidence === "stated";
    const urls = new Map<string, string>();
    const uses: FixedLinks["uses"] = [];
    for (const destination of rewriteLinks(a.text, () => null).destinations) {
      // A link already on this domain, as in text edited from a fixed draft, isn't wrapped again.
      if (new URL(destination).hostname === t.hostname) continue;
      const linkId = await linkFor(tx, { id: randomBytes(16).toString("base64url"), workspaceId, campaignId: a.campaignId, stepKey: a.stepKey, domainId: t.domainId, destination, now: a.now });
      const secret = perPerson ? token() : null;
      urls.set(destination, `https://${t.hostname}/t/${linkId}${secret ? `/${secret}` : ""}`);
      uses.push({ linkId, tokenHash: secret && sha256(secret), personId: secret && a.personId });
    }
    let perRecipient = false;
    const { text } = rewriteLinks(a.text, (destination) => {
      const replacement = urls.get(destination);
      const output = new URL(replacement ?? destination);
      if (output.hostname === t.hostname && RECIPIENT_PATH.test(output.pathname)) perRecipient = true;
      return replacement ?? null;
    });
    return { text, perRecipient, inputsHash: inputsHash(inputs), uses };
  });
}

/** Records the fixed links as used by the Item's Action, in the transaction that wrote it. */
export const recordUses = (tx: TrackingTx, workspaceId: string, itemId: string, fixed: FixedLinks, now: Date) => insertUses(tx, workspaceId, itemId, fixed.inputsHash, fixed.uses, now);
