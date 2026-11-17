// SPDX-License-Identifier: AGPL-3.0-only
// After the send, against both fakes: the issue's id and send time are recorded and the last send
// moves; stats are read at each point and not in between; and a tool that reports deliveries but
// shows none at 30 minutes, with subscribers on the list, warns until deliveries show.
import { expect, test } from "vitest";
import { newsletterWorld } from "./fixtures/world";
import { notDeliveredText } from "./index";

const w = await newsletterWorld();
const at = (iso: string) => (w.clock.at = new Date(iso));

async function sentIssue(connection: "kit" | "beehiiv", key: string) {
  at("2026-11-08T05:00:00Z");
  const { W } = await w.workspace({ connection, key });
  await w.weekly.runOne(W);
  const { id } = await w.latestIssue(W);
  const action = await w.writeAndApprove(W, id);
  expect(action?.state).toBe("sent");
  return { W, id, providerRef: action!.providerRef! };
}

test("Kit: the send is recorded at the slot, stats are read at each point, and Kit's missing deliveries never warn", async () => {
  const { W, id, providerRef } = await sentIssue("kit", w.kit.key);
  at("2026-11-10T08:10:00Z");
  await w.afterSend.runOne(W);
  expect(await w.rows(W, "select provider_ref, sent_at, stats from newsletter_issues")).toEqual([{ provider_ref: providerRef, sent_at: new Date("2026-11-10T08:00:00Z"), stats: null }]);
  expect((await w.rows(W, "select last_sent_at from newsletter_settings"))[0].last_sent_at).toEqual(new Date("2026-11-10T08:00:00Z"));

  w.kit.complete(Number(providerRef));
  Object.assign(w.kit.broadcasts.get(Number(providerRef))!, { opens: 7, clicks: 3, unsubscribes: 1 });
  at("2026-11-10T09:00:00Z");
  const before = w.counts.statsReads;
  await w.afterSend.runOne(W);
  await w.afterSend.runOne(W);
  expect(w.counts.statsReads - before).toBe(1);
  const view = await w.desk.get(W, id);
  expect(view).toMatchObject({ sentAt: "2026-11-10T08:00:00.000Z", handoffTo: null, stats: { clicks: 3, unsubscribes: 1, opens: 7 } });
  expect(view?.stats).not.toHaveProperty("delivered");
  expect(view?.item.warnings).toEqual([]);
});

test("beehiiv: nothing delivered at 30 minutes with subscribers on the list warns, and the warning clears once it delivers", async () => {
  const { W, id, providerRef } = await sentIssue("beehiiv", w.beehiiv.key);
  at("2026-11-10T08:31:00Z");
  await w.afterSend.runOne(W);
  expect((await w.desk.get(W, id))?.item.warnings).toEqual([{ code: "unspecified", text: notDeliveredText("beehiiv") }]);
  expect(notDeliveredText("beehiiv")).toBe("beehiiv accepted this issue but hasn't emailed anyone yet");

  Object.assign(w.beehiiv.posts.get(providerRef)!, { recipients: 1, delivered: 1, opens: 1, clicks: 0, unsubscribes: 0 });
  at("2026-11-10T09:01:00Z");
  await w.afterSend.runOne(W);
  const view = await w.desk.get(W, id);
  expect(view).toMatchObject({ stats: { recipients: 1, delivered: 1, opens: 1 } });
  expect(view?.item.warnings).toEqual([]);
});
