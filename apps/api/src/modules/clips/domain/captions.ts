// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the burned-in captions for one clip, as an ASS file libass draws. Lines follow the words as
// spoken, so a viewer with the sound off reads along.
import type { Word } from "./transcript";

/** [DEFAULT] Short lines read at a glance on a phone. */
const MAX_WORDS = 4;
/** [DEFAULT] A pause this long starts a new line, so a line never spans a silence. */
const PAUSE_MS = 600;
const SENTENCE_END = /[.!?…]["'”’)]*$/;

export type CaptionLine = { startMs: number; endMs: number; text: string };

/** Two to four words a line, broken at a pause or a sentence's end. */
export function captionLines(words: readonly Word[]): CaptionLine[] {
  const lines: Word[][] = [];
  let line: Word[] = [];
  for (const w of words) {
    const prev = line.at(-1);
    if (prev && (line.length >= MAX_WORDS || w.startMs - prev.endMs > PAUSE_MS || SENTENCE_END.test(prev.text))) {
      lines.push(line);
      line = [];
    }
    line.push(w);
  }
  if (line.length) lines.push(line);
  return lines.map((l) => ({ startMs: l[0]!.startMs, endMs: l.at(-1)!.endMs, text: l.map((w) => w.text).join(" ") }));
}

const clock = (ms: number) => {
  const cs = Math.round(Math.max(0, ms) / 10);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** Spoken text never becomes an ASS command: braces start override tags and a backslash starts a code. */
export const escapeAss = (text: string) => text.replace(/[{}\\]/g, "").replace(/[\r\n]+/g, " ");

/** 1080x1920, bold white with a black outline, in the lower third. */
export function captionsAss(words: readonly Word[]): string {
  const events = captionLines(words).map((l) => `Dialogue: 0,${clock(l.startMs)},${clock(l.endMs)},Default,,0,0,0,,${escapeAss(l.text)}`);
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,DejaVu Sans,76,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,80,80,420,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
