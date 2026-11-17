// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what whisper heard, as words with times. Everything after transcription reads this, never
// whisper's own format.

export type Word = { startMs: number; endMs: number; text: string };

type WhisperSegment = { offsets?: { from?: unknown; to?: unknown }; text?: unknown };

/**
 * Words from whisper-cli's JSON, run with one word per segment. Empty segments and whisper's own
 * markers ("[_BEG_]", "[BLANK_AUDIO]") are dropped; anything not shaped as documented is an error.
 */
export function wordsFromWhisper(json: unknown): Word[] {
  const segments = (json as { transcription?: unknown } | null)?.transcription;
  if (!Array.isArray(segments)) throw new Error("whisper's output has no transcription");
  return (segments as WhisperSegment[]).flatMap((s) => {
    const { from, to } = s.offsets ?? {};
    const text = typeof s.text === "string" ? s.text.trim() : "";
    if (typeof from !== "number" || typeof to !== "number") throw new Error("whisper's output has a segment without times");
    if (!text || /^\[[^\]]*\]$/.test(text)) return [];
    return [{ startMs: from, endMs: Math.max(from, to), text }];
  });
}

/** [DEFAULT] A line ends at a sentence end, a pause this long, or this many seconds, whichever comes first. */
const LINE_PAUSE_MS = 1000;
const LINE_MAX_MS = 15_000;

/**
 * The transcript as the agent reads it, one line per stretch of speech, each with its start and end in
 * milliseconds: "[12340-15670] the words". The agent picks moments by these times.
 */
export function timedLines(words: readonly Word[]): string {
  const lines: Word[][] = [];
  let line: Word[] = [];
  for (const w of words) {
    const prev = line.at(-1);
    if (prev && (w.startMs - prev.endMs > LINE_PAUSE_MS || w.endMs - line[0]!.startMs > LINE_MAX_MS || /[.!?]$/.test(prev.text))) {
      lines.push(line);
      line = [];
    }
    line.push(w);
  }
  if (line.length) lines.push(line);
  return lines.map((l) => `[${l[0]!.startMs}-${l.at(-1)!.endMs}] ${l.map((w) => w.text).join(" ")}`).join("\n");
}

/** The words a clip covers, timed from the clip's own start. */
export function wordsIn(words: readonly Word[], startMs: number, endMs: number): Word[] {
  return words.filter((w) => w.endMs > startMs && w.startMs < endMs).map((w) => ({ startMs: Math.max(0, w.startMs - startMs), endMs: Math.min(endMs, w.endMs) - startMs, text: w.text }));
}
