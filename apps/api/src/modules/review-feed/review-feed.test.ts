// SPDX-License-Identifier: AGPL-3.0-only
// Review feeds through identity's real sign-in: who may make one, what the link serves, and that it
// stops working the moment it is rotated or stopped, or its owner is demoted or leaves.
import { expect, test } from "vitest";
import { testIdentity } from "../identity/test-auth";
import { createReviewFeeds, reviewFeedRoutes } from "./index";

const BASE = "http://localhost:3000";
const asked: string[] = [];
const feeds = createReviewFeeds({
  waiting: async (workspaceId) => {
    asked.push(workspaceId);
    return { count: 4, nextDeadline: new Date("2026-11-20T09:00:00Z") };
  },
  baseUrl: () => BASE,
});
const { routes, call, signIn, createOrg, addMember } = testIdentity();
routes.route("/", reviewFeedRoutes({ feeds: () => feeds, reachable: () => false }));

const SETTINGS = { weekdays: [1, 2, 3, 4, 5], startMinute: 9 * 60, lengthMinutes: 30, timeZone: "Europe/London" };
const api = (w: string, rest = "") => `/api/w/${w}/review-feed${rest}`;
const fetchFeed = async (url: string) => routes.request(url.slice(BASE.length));
const starts = (ics: string, hhmmss: string) => ics.match(new RegExp(`^DTSTART:\\d{8}T${hhmmss}Z`, "gm"))?.length ?? 0;

async function world() {
  const owner = await signIn();
  const w = (await createOrg(owner)).workspace.id;
  return { owner, w };
}
async function makeLink(w: string, cookie: string, body: unknown = SETTINGS) {
  const res = await call(api(w, "/link"), cookie, { method: "POST", body });
  expect(res.status).toBe(200);
  return ((await res.json()) as { url: string }).url;
}

test("a Marketer makes a feed and the link serves their review blocks for this Workspace", async () => {
  const { owner, w } = await world();
  const m = await addMember(owner, w, "marketer");
  expect(await (await call(api(w), m.cookie)).json()).toEqual({ feed: null, reachable: false });

  const url = await makeLink(w, m.cookie);
  expect(url).toMatch(new RegExp(`^${BASE}/api/feeds/review/${w}/[0-9a-f]{64}\\.ics$`));
  const res = await fetchFeed(url);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
  const ics = (await res.text()).replace(/\r\n /g, "");
  expect(ics).toContain("SUMMARY:Direx review: 4 waiting\\, next due Fri 20 Nov");
  expect(ics).toContain(`URL:${BASE}/w/${w}`);
  expect(asked.at(-1)).toBe(w);

  const state = (await (await call(api(w), m.cookie)).json()) as { feed: { fetchCount: number; lastFetchedAt: string | null; weekdays: number[] } };
  expect(state.feed).toMatchObject({ fetchCount: 1, weekdays: [1, 2, 3, 4, 5] });
  expect(state.feed.lastFetchedAt).not.toBeNull();
});

test("a wrong token, another Workspace's id or a rotated link gives 404", async () => {
  const { owner, w } = await world();
  const other = (await createOrg(owner, "Other")).workspace.id;
  const url = await makeLink(w, owner);
  const token = url.match(/([0-9a-f]{64})\.ics$/)![1]!;
  expect((await routes.request(`/api/feeds/review/${w}/${"0".repeat(64)}.ics`)).status).toBe(404);
  expect((await routes.request(`/api/feeds/review/${other}/${token}.ics`)).status).toBe(404);
  expect((await routes.request(`/api/feeds/review/${w}/${token}`)).status).toBe(404);
  expect((await routes.request(`/api/feeds/review/not-a-uuid/${token}.ics`)).status).toBe(404);

  const rotated = await makeLink(w, owner);
  expect(rotated).not.toBe(url);
  expect((await fetchFeed(url)).status).toBe(404);
  expect((await fetchFeed(rotated)).status).toBe(200);
});

test("stopping, a demotion below Marketer and leaving the Workspace each end the link", async () => {
  const { owner, w } = await world();
  const stopped = await makeLink(w, owner);
  expect((await call(api(w), owner, { method: "DELETE" })).status).toBe(200);
  expect((await fetchFeed(stopped)).status).toBe(404);
  expect((await call(api(w), owner, { method: "DELETE" })).status).toBe(404);

  const demoted = await addMember(owner, w, "marketer");
  const demotedUrl = await makeLink(w, demoted.cookie);
  expect((await call(`/api/w/${w}/members/${demoted.userId}`, owner, { method: "PATCH", body: { role: "contributor" } })).status).toBe(200);
  expect((await fetchFeed(demotedUrl)).status).toBe(404);

  const leaver = await addMember(owner, w, "marketer");
  const leaverUrl = await makeLink(w, leaver.cookie);
  expect((await call(`/api/w/${w}/members/${leaver.userId}`, owner, { method: "DELETE" })).status).toBe(200);
  expect((await fetchFeed(leaverUrl)).status).toBe(404);
});

test("a Contributor or a Viewer can't make or read a feed", async () => {
  const { owner, w } = await world();
  for (const role of ["contributor", "viewer"]) {
    const m = await addMember(owner, w, role);
    expect((await call(api(w), m.cookie)).status).toBe(403);
    expect((await call(api(w, "/link"), m.cookie, { method: "POST", body: SETTINGS })).status).toBe(403);
  }
  expect((await call(api(w))).status).toBe(401);
});

test("settings are checked, and changing them moves the blocks without changing the link", async () => {
  const { owner, w } = await world();
  for (const bad of [{ weekdays: [0] }, { weekdays: [2, 2] }, { lengthMinutes: 45 }, { startMinute: 1440 }, { timeZone: "Mars/Olympus" }]) {
    expect((await call(api(w, "/link"), owner, { method: "POST", body: { ...SETTINGS, ...bad } })).status).toBe(400);
  }
  expect((await call(api(w), owner, { method: "PUT", body: SETTINGS })).status).toBe(404);

  const every = { ...SETTINGS, weekdays: [1, 2, 3, 4, 5, 6, 7], timeZone: "UTC" };
  const url = await makeLink(w, owner, every);
  expect(starts(await fetchFeed(url).then((r) => r.text()), "090000")).toBe(14);
  expect((await call(api(w), owner, { method: "PUT", body: { ...every, startMinute: 14 * 60 } })).status).toBe(200);
  const moved = await fetchFeed(url).then((r) => r.text());
  expect(starts(moved, "090000")).toBe(0);
  expect(starts(moved, "140000")).toBe(14);
});
