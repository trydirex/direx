// SPDX-License-Identifier: AGPL-3.0-only
// The write-up's pure checks: when one is due, and what a model's write-up may not say.
import { expect, test } from "vitest";
import { claimsWinner, creditPhrase, dueForWriteUp, numbersOutsideBrief, settled, wentOut, writeUpProblem, type Brief, type WriteUpOutput } from "./domain/write-up";

test("settled: every state but held and the open ones is final", () => {
  for (const s of ["sent", "blocked", "cancelled", "applied"]) expect(settled([s]), s).toBe(true);
  for (const s of ["held", "draft", "needs_approval", "scheduled", "claimed", "dispatching"]) expect(settled(["sent", s]), s).toBe(false);
  expect(settled([])).toBe(true);
});

test("wentOut: a sent email or post, or a DM a person marked sent", () => {
  expect(wentOut(["cancelled", "blocked"], 0)).toBe(false);
  expect(wentOut(["cancelled", "sent"], 0)).toBe(true);
  expect(wentOut(["cancelled"], 1)).toBe(true);
});

test("dueForWriteUp: ended, something went out, and settled or 14 days past the end", () => {
  const ended = { status: "ended" as const, endsOn: "2026-11-01", states: ["sent", "blocked"], sentDms: 0 };
  expect(dueForWriteUp(ended, "2026-11-02")).toBe(true);
  expect(dueForWriteUp({ ...ended, status: "running" }, "2026-11-02")).toBe(false);
  expect(dueForWriteUp({ ...ended, states: ["cancelled"] }, "2026-11-30")).toBe(false);
  const held = { ...ended, states: ["sent", "held"] };
  expect(dueForWriteUp(held, "2026-11-14")).toBe(false);
  expect(dueForWriteUp(held, "2026-11-15")).toBe(true);
});

test("numbersOutsideBrief: numbers the brief holds pass, in any of its forms; invented ones are caught", () => {
  const brief = "reading r1: Reply rate 12%, counted by Direx, 2026-11-20\nreading r2: Revenue £1,200, entered by a person\n40 reached, 3 with the outcome";
  expect(numbersOutsideBrief("Replies came in at 12% by 2026-11-20, with £1200 entered and 3 of 40 interested.", brief)).toEqual([]);
  expect(numbersOutsideBrief("Revenue reached £1,250 and 12% replied.", brief)).toEqual(["1250"]);
  expect(numbersOutsideBrief("No numbers here.", brief)).toEqual([]);
  // A sign changes the number; a date's hyphen doesn't.
  expect(numbersOutsideBrief("Revenue was -1,200 on 2026-11-20.", brief)).toEqual(["-1200"]);
  // The digits inside a reading id are not a number the brief gives.
  expect(numbersOutsideBrief("About 52 meetings followed.", "reading 0c52a1f0-1e2b-4c3d-9e8f-123456789abc: Replies 12")).toEqual(["52"]);
  expect(numbersOutsideBrief("Rate reached -.5%.", "Rate reached 0.5%.")).toEqual(["-0.5"]);
  expect(numbersOutsideBrief("Rate reached .5%.", "Rate reached 0.5%.")).toEqual([]);
});

test("writeUpProblem does not treat digits inside brief labels as counts", () => {
  const withLabel = { ...brief, text: `B2B founders; ${brief.text}` };
  expect(writeUpProblem({ ...ok, paragraph: "There were 2 meetings." }, withLabel)).toBe("number_not_in_brief:2");
  expect(writeUpProblem({ ...ok, paragraph: "The campaign reached B2B founders." }, withLabel)).toBeNull();
});

test.each(["most  effective", "least\nsuccessful"])("writeUpProblem checks winner claims across whitespace: %j", (phrase) => {
  const output = { ...ok, paragraph: `Email was the ${phrase} channel.` };
  expect(writeUpProblem(output, brief)).toBe("winner_without_comparison");
  expect(writeUpProblem(output, { ...brief, comparable: true })).toBeNull();
});

test("creditPhrase and claimsWinner catch credit and a winner without a comparison", () => {
  expect(creditPhrase("Meetings came thanks to the DM step.")).toBe("thanks to");
  expect(creditPhrase("People reached by email and LinkedIn DM: 3 interested.")).toBeNull();
  expect(creditPhrase("The DM step generated 12 replies.")).toBe("generated");
  expect(creditPhrase("The second email produced 3 meetings.")).toBe("produced");
  expect(claimsWinner("Email was the most effective channel.", false)).toBe(true);
  expect(claimsWinner("Email was the most effective channel.", true)).toBe(false);
  expect(claimsWinner("Posts were the least successful step.", false)).toBe(true);
  expect(claimsWinner("LinkedIn DM worked better than email.", false)).toBe(true);
  expect(claimsWinner("LinkedIn DM worked better than email.", true)).toBe(false);
  expect(claimsWinner("Both channels reached 40 People.", false)).toBe(false);
  // A negated winner word is no claim, but a later, plain one still is.
  expect(claimsWinner("These groups are too few to compare, so no channel is judged better than another.", false)).toBe(false);
  expect(claimsWinner("We can't say email did better.", false)).toBe(false);
  expect(claimsWinner("Email is not yet best.", false)).toBe(false);
  expect(claimsWinner("No rates are given. Email still did better.", false)).toBe(true);
  expect(claimsWinner("Not much changed, and LinkedIn DM worked best.", false)).toBe(true);
});

test.each(["No rates. Email was best.", "No rates; email was best.", "No rates, email was best.", "No rates but email was best."])(
  "writeUpProblem refuses a winner after a separate negation: %j",
  (paragraph) => {
    expect(writeUpProblem({ ...ok, paragraph }, brief)).toBe("winner_without_comparison");
  },
);

const brief: Brief = {
  text: "reading r1: Replies 12, counted by Direx, 2026-11-20\nemail: 40 reached, 3 with the outcome, too few to compare",
  readingIds: new Set(["r1"]),
  comparable: false,
  assumptions: ["Founders answer cold email within a week"],
};
const ok: WriteUpOutput = {
  schemaVersion: 1,
  paragraph: "The Campaign sent its email steps and got 12 replies by 2026-11-20. Of 40 People reached by email, 3 were interested, too few to compare.",
  cites: ["r1"],
  suggestions: [{ assumption: "A second email step gets more replies than one", because: "12 replies came after the second step.", readingIds: ["r1"] }],
};

test("writeUpProblem passes a write-up that keeps to its brief and names the first problem otherwise", () => {
  expect(writeUpProblem(ok, brief)).toBeNull();
  expect(writeUpProblem({ ...ok, paragraph: `${ok.paragraph} About 15 meetings followed.` }, brief)).toBe("number_not_in_brief:15");
  expect(writeUpProblem({ ...ok, paragraph: "Replies came because of the subject line." }, brief)).toBe("credit:because of");
  expect(writeUpProblem({ ...ok, paragraph: "Email was the best channel." }, brief)).toBe("winner_without_comparison");
  expect(writeUpProblem({ ...ok, cites: ["r9"] }, brief)).toBe("unknown_reading:r9");
  expect(writeUpProblem({ ...ok, paragraph: "There were 12 replies (r1) by 2026-11-20." }, brief)).toBe("reading_id_in_text");
  expect(writeUpProblem({ ...ok, suggestions: [{ ...ok.suggestions[0]!, readingIds: [] }] }, brief)).toBe("suggestion_without_reading");
  expect(writeUpProblem({ ...ok, suggestions: [{ ...ok.suggestions[0]!, assumption: " founders answer cold email  within a week " }] }, brief)).toBe("repeats_assumption");
  expect(writeUpProblem({ ...ok, suggestions: [ok.suggestions[0]!, ok.suggestions[0]!, ok.suggestions[0]!, ok.suggestions[0]!] }, brief)).toBe("too_many_suggestions:4");
  expect(writeUpProblem({ ...ok, paragraph: "word ".repeat(121) }, brief)).toBe("too_long:121");
});
