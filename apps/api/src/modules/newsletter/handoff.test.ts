// SPDX-License-Identifier: AGPL-3.0-only
// Handoffs: beehiiv refusing on its plan makes the list read-only and the refused issue a handoff, the
// next week is a handoff too, and a new key ends it. Substack only ever gets handoffs, and no handoff
// reaches the ledger as an effect.
import { expect, test } from "vitest";
import { newsletterWorld, person } from "./fixtures/world";
import { HANDOFF_KIND, readOnlyText, SUBSTACK } from "./index";

const w = await newsletterWorld();
const at = (iso: string) => (w.clock.at = new Date(iso));

test("beehiiv without Pro: refused, read-only, a handoff to send by hand, then a new key sends again", async () => {
  at("2026-11-08T05:00:00Z");
  const { W, credentialId } = await w.workspace({ connection: "beehiiv", key: w.beehiivFree.key });
  await w.weekly.runOne(W);
  const first = await w.latestIssue(W);
  const refused = await w.writeAndApprove(W, first.id);
  expect(refused).toMatchObject({ state: "held", holdReason: "provider_rejected", reasonPlan: "Pro" });

  // The next pass turns the list read-only and this week's issue into a handoff, words kept.
  await w.afterSend.runOne(W);
  expect(await w.newsletter.settings(W)).toMatchObject({ readOnlySince: expect.any(String), readOnlyReason: "beehiiv Pro" });
  expect((await w.items.view(W, first.id))?.state).toBe("cancelled");
  const handoff = await w.latestIssue(W);
  expect(handoff).toMatchObject({ kind: HANDOFF_KIND, state: "needs_approval", warnings: [{ code: "unspecified", text: readOnlyText("beehiiv", "Pro") }] });
  expect(await w.desk.get(W, handoff.id)).toMatchObject({ title: "Week 45", handoffTo: "beehiiv", html: "<p>Hello.</p>" });
  expect(handoff.title).toBe("Week 45");
  // Its slot has passed, but it waits for the person rather than being skipped.
  at("2026-11-10T10:00:00Z");
  await w.weekly.runOne(W);
  expect((await w.items.view(W, handoff.id))?.state).toBe("needs_approval");

  // Approved, it waits for the person; "I sent it" finishes it and counts as the send.
  const approved = await w.items.approve(W, handoff.id, handoff.revision, w.who);
  expect(approved).toMatchObject({ ok: true, item: { state: "scheduled" } });
  expect(await w.desk.markSent(W, handoff.id, person.userId)).toMatchObject({ ok: true, issue: { item: { state: "applied" }, sentAt: "2026-11-10T10:00:00.000Z" } });
  expect((await w.newsletter.settings(W))?.lastSentAt).toBe("2026-11-10T10:00:00.000Z");
  expect(w.beehiivFree.posts.size).toBe(0);

  // While read-only, the next week's issue is a handoff from the start.
  at("2026-11-15T05:00:00Z");
  await w.weekly.runOne(W);
  const next = await w.latestIssue(W);
  expect(next).toMatchObject({ kind: HANDOFF_KIND, state: "draft" });

  // A replaced key clears read-only, so the week after is published again.
  await w.newsletter.clearReadOnly(W, credentialId!);
  expect(await w.newsletter.settings(W)).toMatchObject({ readOnlySince: null, readOnlyReason: null });
  at("2026-11-22T05:00:00Z");
  await w.weekly.runOne(W);
  expect((await w.latestIssue(W)).kind).toBe("action");
});

test("Substack gives handoffs only, and none reaches the ledger", async () => {
  at("2026-11-08T05:00:00Z");
  const { W } = await w.workspace("substack");
  await w.weekly.runOne(W);
  const issue = await w.latestIssue(W);
  expect(issue).toMatchObject({ kind: HANDOFF_KIND, state: "draft" });
  expect(await w.writeAndApprove(W, issue.id)).toBeNull();
  expect(await w.desk.get(W, issue.id)).toMatchObject({ handoffTo: SUBSTACK, item: { state: "scheduled" } });
  expect(await w.rows(W, "select id from actions")).toEqual([]);
});
