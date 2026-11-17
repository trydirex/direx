// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { captionLines, captionsAss, escapeAss } from "./domain/captions";
import { wordsFromWhisper, wordsIn, type Word } from "./domain/transcript";
import jfk from "./fixtures/jfk-whisper.json";

// whisper-cli v1.9.5, base q5_1, on its own samples/jfk.wav (public domain), with -ml 1 -sow -oj.
const words = wordsFromWhisper(jfk);

test("whisper's JSON becomes words with times, its markers and empty segments dropped", () => {
  expect(words[0]).toEqual({ startMs: 220, endMs: 330, text: "And" });
  expect(words.map((w) => w.text).join(" ")).toBe("And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.");
  expect(wordsFromWhisper({ transcription: [{ offsets: { from: 0, to: 10 }, text: " [BLANK_AUDIO]" }] })).toEqual([]);
  expect(() => wordsFromWhisper({})).toThrow("no transcription");
  expect(() => wordsFromWhisper({ transcription: [{ text: "x" }] })).toThrow("without times");
});

test("a clip's words are timed from its own start and clipped to its end", () => {
  expect(wordsIn(words, 3000, 5000)).toEqual([
    { startMs: 0, endMs: 290, text: "Americans," },
    { startMs: 290, endMs: 1010, text: "ask" },
    { startMs: 1010, endMs: 1990, text: "not" },
    { startMs: 1990, endMs: 2000, text: "what" },
  ]);
});

const w = (startMs: number, endMs: number, text: string): Word => ({ startMs, endMs, text });

test("lines hold at most four words and break at a pause or a sentence's end", () => {
  const lines = captionLines([w(0, 100, "one"), w(100, 200, "two"), w(200, 300, "three"), w(300, 400, "four"), w(400, 500, "five."), w(500, 600, "six"), w(1300, 1400, "seven")]);
  expect(lines.map((l) => l.text)).toEqual(["one two three four", "five.", "six", "seven"]);
  expect(lines[0]).toMatchObject({ startMs: 0, endMs: 400 });
  expect(captionLines([])).toEqual([]);
});

test("spoken text can't become an ASS command, and times are in centiseconds", () => {
  expect(escapeAss("a {\\pos(0,0)} b\nc")).toBe("a pos(0,0) b c");
  const ass = captionsAss([w(61_005, 62_500, "{\\b0}hi")]);
  expect(ass).toContain("PlayResX: 1080\nPlayResY: 1920");
  expect(ass).toContain("Dialogue: 0,0:01:01.01,0:01:02.50,Default,,0,0,0,,b0hi");
});
