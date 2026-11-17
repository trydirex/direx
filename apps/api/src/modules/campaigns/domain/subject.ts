// SPDX-License-Identifier: AGPL-3.0-only
// A first email that looks like a reply or a forward pretends a conversation already happened, so a
// subject starting like one needs a person's decision. Covers the usual English and European forms.
const PREFIX = /^\s*[[(]?\s*(?:re|fw|fwd|aw|wg|sv|vs|rv|tr|antw|réf|ref)\s*[\])]?\s*:/iu;

/** NFKC first, so a full-width colon counts as a colon. */
export const replyPrefix = (subject: string): boolean => PREFIX.test(subject.normalize("NFKC"));
