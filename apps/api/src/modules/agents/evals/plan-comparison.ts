// SPDX-License-Identifier: AGPL-3.0-only
// A sentence naming a channel with a comparison, and no uncertainty, claims a winner
// that the too-few-to-compare rows cannot support. A past "test" alone is not uncertainty.
// Uncertainty counts only in the clause it sits in: a hedge about the target doesn't excuse
// a winner named in the clause before it. The channel may sit in another clause ("Email is
// cheap, but it worked better").
const COMPARES = /\b(better|best|outperform\w*|more effective|stronger|strongest|higher|beat|won|winner)\b/i;
const CHANNEL = /e-?mail|linkedin|\bdms?\b|channel/i;
const CHANNEL_LIST = /\b(?:e-?mail|linkedin|dms?)(?:,\s*(?:e-?mail|linkedin|dms?))*(?:,\s*|\s+)(?:or|and)\s+(?:e-?mail|linkedin|dms?|both)\b/gi;
const HEDGED = /\b(too few|not enough|no clear|unclear|not yet|don't know|unknown)\b|\b(can't|cannot)\s+(?:(?:yet|really)\s+)*(tell|compare|conclude|say|determine)\b|\bisn't (clear|known|enough)\b|\btest (whether|if)\b/i;

export function unsupportedChannelComparison(sentence: string): boolean {
  // Keep list commas inside the comparison; other commas can separate a claim from a hedge.
  const clauses = sentence.replace(CHANNEL_LIST, (list) => list.replace(/,/g, " ")).split(/[,;:]|\bbut\b/i);
  return (
    CHANNEL.test(sentence) &&
    clauses.some((clause) => COMPARES.test(clause) && !HEDGED.test(clause))
  );
}
