// SPDX-License-Identifier: AGPL-3.0-only
// The results section shows the server's counts as they are: a verdict only where it names one, with
// the checks sent and the matching reports; otherwise the server's "fewer than 3" sentence. Plain and
// content rows stay apart, the bootstrap sentence shows while the list is bootstrap, and the reports
// this Mailbox sent show with their state.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { api } from "../client";
import { withQueries } from "../testing";
import { Placement } from "./Placement";
import { momentWords } from "../campaigns/actions";
import type { PlacementResults } from "./actions";

const W = "00000000-0000-4000-8000-0000000000aa";
const M = "00000000-0000-4000-8000-0000000000c1";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const FEWER = "fewer than 3 matching reports";
const NOTE = "The Placement circle is still starting: fewer than 3 people sign its member list, so one person decides who is in it.";
const none = (sent: number, counted: number) => ({ sent, counted, verdicts: [], note: FEWER });
const results = (r: Partial<PlacementResults>): PlacementResults => ({ bootstrap: true, bootstrapNote: NOTE, weeks: [], reportsSent: [], ...r });
const show = async (r: unknown, status = 200) => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(status, r)) as never);
  const view = render(withQueries(<Placement workspaceId={W} credentialId={M} name="me@acme.test" />));
  await new Promise((done) => setTimeout(done, 20));
  return view;
};
const rows = () => screen.getAllByRole("row").slice(1).map((r) => Array.from(r.querySelectorAll("td"), (c) => c.textContent));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("2 matching reports show no verdict, and plain and content rows stay apart", async () => {
  await show(results({ weeks: [{ week: "2026-W50", plain: none(2, 2), content: none(2, 2), difference: [] }] }));
  expect(screen.getByRole("region", { name: "Placement checks: me@acme.test" })).toBeTruthy();
  expect(rows()).toEqual([
    ["Week 50, 2026", "Sample email", "2", "2", "Fewer than 3 matching reports"],
    ["Week 50, 2026", "Real email", "2", "2", "Fewer than 3 matching reports"],
  ]);
  expect(screen.queryByText(/Spam/)).toBeNull();
});

test("3 matching reports show the verdict with the checks sent and the matching count, under the bootstrap sentence", async () => {
  await show(
    results({
      weeks: [
        {
          week: "2026-W49",
          plain: { sent: 4, counted: 4, verdicts: [{ verdict: "primary", reports: 3 }], note: null },
          content: { sent: 3, counted: 3, verdicts: [{ verdict: "primary", reports: 3 }], note: null },
          difference: [{ verdict: "primary", plain: 3, content: 3 }],
        },
      ],
    }),
  );
  expect(screen.getByText(NOTE)).toBeTruthy();
  expect(rows()).toEqual([
    ["Week 49, 2026", "Sample email", "4", "4", "Primary: 3 matching reports"],
    ["Week 49, 2026", "Real email", "3", "3", "Primary: 3 matching reports"],
  ]);
  expect(screen.getByText("Week 49, 2026, Primary: 3 matching reports for the sample email, 3 for the real email.")).toBeTruthy();
});

test("a list signed by 3 or more drops the bootstrap sentence; the reports this Mailbox sent show with their state", async () => {
  const at = "2026-12-11T06:05:00.000Z";
  await show(
    results({
      bootstrap: false,
      bootstrapNote: null,
      reportsSent: [
        { sender: "kim@circle.test", day: "2026-12-10", kind: "content", verdict: "missing", state: "sent", holdReason: null, at },
        { sender: "kim@circle.test", day: "2026-12-09", kind: "plain", verdict: "spam", state: "held", holdReason: "outcome_unknown", at },
      ],
    }),
  );
  expect(screen.queryByText(NOTE)).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    `Thu 10 Dec, to kim@circle.test: real email check, Missing. Sent ${momentWords(at)}`,
    "Wed 9 Dec, to kim@circle.test: sample email check, Spam. Held: not sure it sent",
  ]);
});

test("nothing shows where placement isn't available, or before any check or report", async () => {
  for (const [r, status] of [[{ error: "not_available" }, 404], [results({}), 200]] as const) {
    const { container } = await show(r, status);
    expect(container.textContent).toBe("");
    cleanup();
    vi.restoreAllMocks();
  }
});

test("the latest Placement check is the newest week's leading verdict, and nothing before a verdict", async () => {
  const { latestPlacement } = await import("./Placement");
  const v = (verdict: string) => ({ sent: 3, counted: 3, verdicts: [{ verdict, reports: 3 }], note: null });
  expect(latestPlacement(results({ weeks: [{ week: "2026-W50", plain: v("spam"), content: v("primary"), difference: [] }, { week: "2026-W49", plain: v("primary"), content: v("primary"), difference: [] }] }))).toBe("Week 50, 2026: Spam");
  expect(latestPlacement(results({ weeks: [{ week: "2026-W50", plain: none(2, 2), content: v("other_tab"), difference: [] }] }))).toBe("Week 50, 2026: Another tab");
  expect(latestPlacement(results({ weeks: [{ week: "2026-W50", plain: none(2, 2), content: none(1, 1), difference: [] }] }))).toBeNull();
  expect(latestPlacement(undefined)).toBeNull();
});
