// SPDX-License-Identifier: AGPL-3.0-only
// Pure: finds banned phrases in text. It matches words, not meaning, so "no guaranteed ROI"
// matches "guaranteed ROI". A match is a warning for a person to read, never a verdict.

const pattern = (phrase: string) => {
  const words = phrase.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join("\\s+")}(?![\\p{L}\\p{N}])`, "iu");
};

export const bannedIn = (text: string, phrases: readonly string[]) => phrases.filter((p) => p.trim() && pattern(p).test(text));
