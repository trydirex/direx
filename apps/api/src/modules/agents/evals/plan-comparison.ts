// SPDX-License-Identifier: AGPL-3.0-only
// A sentence naming a channel with a comparison, and no uncertainty, claims a winner
// that the too-few-to-compare rows cannot support. A past "test" alone is not uncertainty.
const COMPARES = /\b(better|best|outperform\w*|more effective|stronger|strongest|higher|beat|won|winner|worked)\b/i;
const CHANNEL = /e-?mail|linkedin|\bdms?\b|channel/i;
const HEDGED = /\b(too few|not enough|no clear|unclear|not yet|don't know|unknown)\b|\b(can't|cannot) (tell|compare|conclude|say|determine)\b|\bisn't (clear|known|enough)\b|\btest (whether|if)\b/i;

export function unsupportedChannelComparison(sentence: string): boolean {
  return COMPARES.test(sentence) && CHANNEL.test(sentence) && !HEDGED.test(sentence);
}
