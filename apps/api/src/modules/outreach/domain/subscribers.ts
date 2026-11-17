// SPDX-License-Identifier: AGPL-3.0-only
// Pure: whether a Touch waits because its Person has been on a newsletter list. Only cold email
// waits, and not when the approved email itself says it goes to a subscriber, since a person read
// that and said yes.
export const subscriberHold = (touch: { touchClass: string; newsletterSubscriber?: true | undefined }, onList: boolean): boolean =>
  touch.touchClass === "cold" && onList && touch.newsletterSubscriber !== true;

/** What a cold draft to a subscriber warns, so the person approving it knows what they say yes to. */
export const subscriberWarningText = (who: string) => `${who} is a newsletter subscriber. Send this cold email anyway?`;
