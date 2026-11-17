// SPDX-License-Identifier: AGPL-3.0-only
// Pure: whether Direx may start or continue cold mail to a Person the workspace may already be
// talking to. A certain hold (a deal, a booking, a person saying so) outranks a guess, and a guess
// outranks a colleague's deal.

const DAY = 86_400_000;
/** How long a hand-written email keeps its recipient held. */
export const INFERRED_FOR_DAYS = 90;
/** How long a Person stays out of cold mail after a certain hold ends, however it ended. */
export const WAIT_AFTER_DAYS = 90;

export type CertainHold = { reason: string; startedAt: Date; expiresAt: Date; endedAt: Date | null };

export type HoldState =
  | { kind: "none" }
  /** `running` is false once every certain hold has ended and only the wait after it is left. */
  | { kind: "certain"; reason: string; until: Date; running: boolean }
  | { kind: "inferred"; lastWritten: Date }
  | { kind: "company"; domain: string; reason: string };

export type HoldInput = {
  now: Date;
  /** Certain holds on any address in the Person's group. */
  own: readonly CertainHold[];
  /** Certain holds on other people at the group's company domains. */
  company: readonly (CertainHold & { domain: string })[];
  /** The newest hand-written email to any address in the group. */
  lastWritten: Date | null;
  /** The newest release of each kind for this Person. */
  released: { inferred: Date | null; company: Date | null };
};

const endOf = (h: CertainHold) => (h.endedAt && h.endedAt < h.expiresAt ? h.endedAt : h.expiresAt);
const active = (h: CertainHold, now: Date) => h.startedAt <= now && now < endOf(h);

export function holdFor(i: HoldInput): HoldState {
  // Ending a hold early never shortens the wait, so a lost deal doesn't get cold mail the next morning.
  const certain = i.own
    .map((h) => ({ reason: h.reason, until: new Date(endOf(h).getTime() + WAIT_AFTER_DAYS * DAY) }))
    .filter((h) => i.now < h.until)
    .sort((a, b) => b.until.getTime() - a.until.getTime())[0];
  if (certain) return { kind: "certain", ...certain, running: i.own.some((h) => active(h, i.now)) };

  const w = i.lastWritten;
  if (w && i.now.getTime() - w.getTime() < INFERRED_FOR_DAYS * DAY && !(i.released.inferred && i.released.inferred >= w)) {
    return { kind: "inferred", lastWritten: w };
  }

  // A release covers the colleague holds that existed when it was made; a newer deal holds again.
  const colleague = i.company.find((h) => active(h, i.now) && !(i.released.company && i.released.company >= h.startedAt));
  return colleague ? { kind: "company", domain: colleague.domain, reason: colleague.reason } : { kind: "none" };
}

/** The domain that stands for an address's company, or null for a shared mail provider's address. */
export function companyOf(email: string, sharedMail: (domain: string) => boolean): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  return domain.includes(".") && !sharedMail(domain) ? domain : null;
}
