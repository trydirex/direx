// SPDX-License-Identifier: AGPL-3.0-only
// A video post from upload to published: the real media module on disk, plans, Items, ledger and plugin
// host, and the LinkedIn plugin against a fake LinkedIn. Only the approved bytes are ever posted.
import { createLinkedInPlugin, createThreadsPlugin, createXPlugin, fakeLinkedIn, fakeThreads, socialNetworks } from "@direx/extensions";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { appClient } from "../../../test/db";
import { createBoss } from "./jobs/boss";
import { createClips, CUT_QUEUE, MOMENTS_OUTPUT_KEY, TRANSCRIBE_QUEUE, type Engine } from "./modules/clips/index";
import { campaignCheck, campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, createCampaigns, templateVersion } from "./modules/campaigns/index";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "./modules/credentials/index";
import { createFacts, factKinds, factVersion } from "./modules/facts/index";
import { approverMayApprove, workspaceLive } from "./modules/identity/index";
import { createItems, itemRoutes } from "./modules/items/index";
import { createMedia, diskStore, mediaKey, mediaRoutes } from "./modules/media/index";
import { TEST_SECRET, testIdentity, testLedger } from "./modules/outreach/fixtures/support";
import { createOutreach, outreachFloors } from "./modules/outreach/index";
import { createPlans, planKinds, type PlanBody } from "./modules/plans/index";
import { loadPlugins } from "./modules/plugins/index";
import { touchCheck } from "./modules/schedule/index";
import { accountHealthCheck, createPosts, postLimitCheck, socialKinds } from "./modules/social/index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;

const dir = await mkdtemp(join(tmpdir(), "direx-social-video-"));
const li = fakeLinkedIn();
const th = fakeThreads();
// The link a plugin reads through is a real HTTP route, as in production.
const linkApp = new OpenAPIHono().route("/", mediaRoutes({ media: () => files }));
const linkServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: linkApp.fetch });
const files = createMedia({ store: () => diskStore(dir), now: () => new Date(), links: { baseUrl: () => `http://127.0.0.1:${linkServer.port}`, secret: () => "v".repeat(32) } });
afterAll(async () => {
  li.stop();
  th.stop();
  linkServer.stop(true);
  await rm(dir, { recursive: true, force: true });
});

// X's video is built here as it will be once the pilot's app confirms its tier allows media upload.
const networks = () =>
  socialNetworks()
    .filter((n) => ["linkedin", "instagram", "x", "threads"].includes(n.connection))
    .map((n) => (n.connection === "x" ? { ...n, features: n.features.map((f) => (f.key === "video" ? { ...f, built: true } : f)) } : n));
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });
const plugins = loadPlugins({
  sources: [
    { mode: "in_process", plugin: createLinkedInPlugin({ baseUrl: li.url, timeoutMs: 5000, videoWait: { everyMs: 5, forMs: 100 } }) },
    { mode: "in_process", plugin: createXPlugin() },
    { mode: "in_process", plugin: createThreadsPlugin({ baseUrl: th.url, timeoutMs: 5000, videoWait: { everyMs: 5, forMs: 100 } }) },
  ],
  credentials: async () => ({ accessToken: "tok", expiresAt: "2030-01-01T00:00:00Z" }),
  confinement: "none",
  log: () => {},
  mediaLinks: (ws, ref) => files.link(ws, ref),
});
const { clock, ledger } = await testLedger({
  effects: plugins.effects,
  resolvers: { credential: credentialLabel, fact: factVersion, template: templateVersion, capability: async (_tx, id) => plugins.capabilityVersion(id) },
  checks: [workspaceLive(), outreachFloors(async () => true), campaignCheck(), postLimitCheck({ plugins: () => plugins, networks, now: () => clock.at }), accountHealthCheck({ now: () => clock.at }), approverMayApprove(), touchCheck({ effects: plugins.effects, now: () => clock.at }), credentialReady],
  now: () => clock.at,
});
const now = () => clock.at;
const items = createItems({ ledger, now, kinds: { ...factKinds(), ...planKinds({ now, onPlanApproved: campaignOnPlanApproved({ now, items: () => items }) }), ...campaignKinds({ now }), ...socialKinds() } });
const outreach = createOutreach({ items: () => items, send: () => undefined, baseUrl: () => "http://direx.test", now });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
// The address a network fetches a video from; a test moves it between public and localhost.
let baseUrl = "https://direx.example.com";
const posts = createPosts({ plugins: () => plugins, vault: () => ({ appSource: async () => "system" }), networks, items: () => items, media: () => files, baseUrl: () => baseUrl, now });
// The clip engine for real, its tools stood in for: words at fixed times, and each cut a small video
// whose bytes name its clip. The picker hands over whatever the test scripts.
const boss = createBoss();
await boss.start();
// Jobs are queued as in production; the test runs each stage itself.
for (const queue of [TRANSCRIBE_QUEUE, CUT_QUEUE]) await boss.createQueue(queue);
afterAll(() => boss.stop({ graceful: false, close: true }));
let script: unknown = null;
const engine: Engine = {
  findTools: () => ({ ffmpeg: "ffmpeg", ffprobe: "ffprobe", whisper: "whisper-cli" }),
  probe: async () => ({ durationMs: 200_000, hasVideo: true, hasAudio: true }),
  toWav: async () => {},
  transcribe: async () => Array.from({ length: 400 }, (_, i) => ({ startMs: i * 500, endMs: i * 500 + 400, text: `w${i}` })),
  cut: async (_t, work, _source, clip) => writeFile(join(work, clip.out), video(MiB, "isom", clip.startMs / 1000)),
  ensureModel: async () => join(dir, "model.bin"),
};
const clips = createClips({
  boss,
  media: () => files,
  facts,
  measures: async () => [],
  startPick: () => async (workspaceId, a) => {
    if (script) await clips.sink(workspaceId, { kind: "draft", outputKey: MOMENTS_OUTPUT_KEY, body: script }, { runId: "r", input: a.input, tainted: true, pagesRead: [], pages: [], producer: { agent: "clip_picker", definitionVersion: 1, promptDigest: "p", routeHash: "r" } });
    return { ok: true, runId: crypto.randomUUID() };
  },
  agentRun: () => async () => ({ status: "running", reason: null }),
  dataDir: () => dir,
  engine,
  onDone: (workspaceId, runId) => campaigns.clipStepDone(workspaceId, runId),
  now: () => clock.at,
});
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, posts: () => posts, clips: () => clips, startDraft: () => async () => ({ ok: false, reason: "not_here" }), now });

const { routes, signIn, createOrg, call } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", itemRoutes({ items: () => items }));
const cookie = await signIn();
const W = (await createOrg(cookie, "Video")).workspace.id;
const db = await appClient();
afterAll(() => db.end());
async function q(text: string, params: unknown[] = []) {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  const r = await db.query(text, params);
  await db.query("commit");
  return r.rows;
}
const owner = (await q("select user_id from workspace_members"))[0].user_id as string;
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};
const revisionOf = async (id: string) => ((await (await call(`/api/w/${W}/items/${id}`, cookie)).json()) as { item: { revision: number } }).item.revision;
const approve = async (id: string) => call(`/api/w/${W}/items/${id}/approve`, cookie, { method: "POST", body: { revision: await revisionOf(id) } });

const saved = ok(await plans.saveStrategyDraft(W, { revision: 0, body: { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "social", label: "Social", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] } }));
expect((await approve(ok(await plans.submitStrategy(W, { revision: saved.revision, actor: { userId: owner } })).item.id)).status).toBe(200);
const body: PlanBody = { schemaVersion: 1, goal: "Reach", audience: "Ops", startsOn: "2026-11-02", endsOn: "2026-11-30", steps: [{ key: "launch", on: "2026-11-03", title: "Launch clip" }], measures: [{ key: "m", label: "Reach", target: "4", basis: { kind: "assumption" } }], budget: [], assumptions: [] };
async function postStep() {
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: owner });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  expect((await approve(ok(await plans.submitPlan(W, plan.id, { revision, actor: { userId: owner } })).item.id)).status).toBe(200);
  const id = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
  ok(await campaigns.setupStep(W, id, "launch", { type: "post", touchClass: null, mailboxCredentialId: null, audience: "everyone" }));
  return id;
}
async function linkedin() {
  return account("linkedin", ["w_member_social"]);
}
async function account(connection: string, scopes: string[]) {
  const c = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: crypto.randomUUID(), name: "Ana", meta: {}, value: { key: "x" } });
  if (!c.ok) throw new Error(c.reason);
  await q("update credentials set kind = 'oauth2', scope = 'user', owner_user_id = $1, connection = $4, meta = $3 where id = $2", [owner, c.credential.id, JSON.stringify({ scopes }), connection]);
  const networkId = crypto.randomUUID();
  // Says who runs it, so the clips here carry no disclosure warning.
  await q("insert into social_accounts (workspace_id, credential_id, connection, account_type, network_id, name, run_by) values ($1, $2, $4, 'member', $3, 'Ana', 'Bio says: run by Acme')", [W, c.credential.id, networkId, connection]);
  return { connection, credentialId: c.credential.id, networkId };
}
const WHEN = new Date("2026-11-03T09:00:00Z");
type Result = { ok: boolean; itemId: string; mode: string; reason?: string; detail?: string };
const draft = async (id: string, targets: Parameters<typeof campaigns.draftPosts>[3]["targets"]) => ok(await campaigns.draftPosts(W, id, "launch", { plannedAt: WHEN, targets }, owner)).results as Result[];
const dispatch = async (itemId: string) => {
  clock.at = new Date(Math.max(clock.at.getTime(), WHEN.getTime() + 60_000));
  await ledger.run(W, (await items.actionIdOf(W, itemId))!);
};
const actionOf = async (itemId: string) => (await q("select state, spec, result, reason_detail as detail from actions where id = $1", [await items.actionIdOf(W, itemId)]))[0] as { state: string; spec: Record<string, unknown>; result: { url?: string } | null; detail: string | null };
const payloadOf = async (itemId: string) => (await q("select payload from items where id = $1", [itemId]))[0]?.payload as unknown;

const MiB = 1024 * 1024;
const video = (size: number, brand = "isom", seed = 0) => {
  const b = new Uint8Array(size).map((_, i) => (i + seed) % 253);
  b.set([0, 0, 0, 0x20, ...new TextEncoder().encode(`ftyp${brand}`)]);
  return b;
};
async function upload(bytes: Uint8Array<ArrayBuffer>, fileName = "launch.mp4") {
  const r = await files.upload({ workspaceId: W, userId: owner, kind: "clip", fileName, declaredBytes: bytes.length, body: new Response(bytes).body });
  return ok(r).media.id;
}

test("a video post publishes on LinkedIn and becomes a hand post with its file on Instagram", async () => {
  clock.at = new Date("2026-11-02T09:00:00Z");
  li.reset();
  const id = await postStep();
  const mediaId = await upload(video(5 * MiB));
  const a = await linkedin();
  const [onLinkedIn, onInstagram] = await draft(id, [
    { ...a, text: "Launch day", mediaId },
    { connection: "instagram", credentialId: null, networkId: null, text: "Launch day", mediaId },
  ]);
  expect([onLinkedIn!.mode, onInstagram!.mode]).toEqual(["publish", "manual"]);
  expect(await payloadOf(onInstagram!.itemId)).toEqual({ text: "Launch day", followUps: [], video: { mediaId, fileName: "launch.mp4" } });
  expect((await actionOf(onLinkedIn!.itemId)).spec.media).toEqual([expect.objectContaining({ mediaId, bytes: 5 * MiB, contentType: "video/mp4" })]);

  expect((await approve(onLinkedIn!.itemId)).status).toBe(200);
  await dispatch(onLinkedIn!.itemId);
  expect(await actionOf(onLinkedIn!.itemId)).toMatchObject({ state: "sent", result: { url: "https://www.linkedin.com/feed/update/urn:li:share:7/" } });
  expect(li.calls.filter((c) => c.path.startsWith("/upload/")).map((c) => c.bytes)).toEqual([4 * MiB, MiB]);
  expect(JSON.parse(li.calls.at(-1)!.body)).toMatchObject({ content: { media: { id: "urn:li:video:V1" } } });
});

test("bytes changed after approval are held, and nothing is posted", async () => {
  clock.at = new Date("2026-11-02T09:00:00Z");
  li.reset();
  const id = await postStep();
  const mediaId = await upload(video(MiB));
  const [r] = await draft(id, [{ ...(await linkedin()), text: "Swap", mediaId }]);
  expect((await approve(r!.itemId)).status).toBe(200);
  // Someone with disk access replaces the file under the same id.
  await diskStore(dir).put(mediaKey(W, mediaId), new Response(video(MiB, "isom", 9)).body!);
  await dispatch(r!.itemId);
  const action = await actionOf(r!.itemId);
  expect(action.state).not.toBe("sent");
  expect(action.detail).toBe("the video is not the one approved, so it was not posted");
  expect(li.paths()).not.toContain("/rest/posts");
});

test("a file deleted after approval holds the post before LinkedIn is called", async () => {
  clock.at = new Date("2026-11-02T09:00:00Z");
  li.reset();
  const id = await postStep();
  const mediaId = await upload(video(MiB));
  const [r] = await draft(id, [{ ...(await linkedin()), text: "Gone", mediaId }]);
  expect((await approve(r!.itemId)).status).toBe(200);
  await files.remove(W, mediaId);
  await dispatch(r!.itemId);
  expect((await actionOf(r!.itemId)).detail).toBe("the approved file was deleted or changed after approval");
  expect(li.calls).toEqual([]);
});

test("at draft: a file LinkedIn won't take, or one that isn't here, is refused; a text post carries no media", async () => {
  clock.at = new Date("2026-11-02T09:00:00Z");
  const id = await postStep();
  const a = await linkedin();
  const mov = await upload(video(1000, "qt  "), "talk.mov");
  const [wrongType, unknown, text] = await draft(id, [
    { ...a, text: "MOV", mediaId: mov },
    { ...(await linkedin()), text: "Missing", mediaId: crypto.randomUUID() },
    { ...(await linkedin()), text: "Just text" },
  ]);
  expect(wrongType).toMatchObject({ ok: false, reason: "refused_by_network", detail: "LinkedIn takes MP4 up to 500 MB; this file is MOV" });
  expect(unknown).toMatchObject({ ok: false, reason: "unknown_media" });
  expect(Object.keys((await actionOf(text!.itemId)).spec)).toEqual(expect.not.arrayContaining(["media"]));
});

const pngOf = (size: number, seed = 0) => {
  const b = new Uint8Array(size).map((_, i) => (i + seed) % 251);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  return b;
};

test("an image post publishes on LinkedIn with its alt text, and becomes a hand post with its images on Instagram", async () => {
  clock.at = new Date("2026-11-02T09:00:00Z");
  li.reset();
  const id = await postStep();
  const [one, two] = [await upload(pngOf(30_000), "chart.png"), await upload(pngOf(20_000, 3), "team.png")];
  const [onLinkedIn, onInstagram] = await draft(id, [
    { ...(await linkedin()), text: "Our numbers", mediaIds: [one, two], alt: ["A chart of Q4", ""] },
    { connection: "instagram", credentialId: null, networkId: null, text: "Our numbers", mediaIds: [one, two], alt: ["A chart of Q4", ""] },
  ]);
  expect([onLinkedIn!.mode, onInstagram!.mode]).toEqual(["publish", "manual"]);
  expect(await payloadOf(onInstagram!.itemId)).toEqual({ text: "Our numbers", followUps: [], images: [{ mediaId: one, fileName: "chart.png", alt: "A chart of Q4" }, { mediaId: two, fileName: "team.png", alt: "" }] });
  const spec = (await actionOf(onLinkedIn!.itemId)).spec;
  expect(spec.media).toEqual([expect.objectContaining({ mediaId: one, contentType: "image/png" }), expect.objectContaining({ mediaId: two })]);
  expect(spec.alt).toEqual(["A chart of Q4", ""]);

  expect((await approve(onLinkedIn!.itemId)).status).toBe(200);
  await dispatch(onLinkedIn!.itemId);
  expect((await actionOf(onLinkedIn!.itemId)).state).toBe("sent");
  expect(li.calls.filter((c) => c.path.startsWith("/upload/image")).map((c) => c.bytes)).toEqual([30_000, 20_000]);
  expect(JSON.parse(li.calls.at(-1)!.body).content).toEqual({ multiImage: { images: [{ id: "urn:li:image:I1", altText: "A chart of Q4" }, { id: "urn:li:image:I2" }] } });
});

test("at draft: a video with images, a video given as an image, and more than four are refused", async () => {
  clock.at = new Date("2026-11-02T09:00:00Z");
  const id = await postStep();
  const png = await upload(pngOf(1000), "a.png");
  const mp4 = await upload(video(1000));
  const [both, notAnImage, five] = await draft(id, [
    { ...(await linkedin()), text: "Both", mediaId: mp4, mediaIds: [png] },
    { ...(await linkedin()), text: "Video", mediaIds: [mp4] },
    { ...(await linkedin()), text: "Five", mediaIds: [png, png, png, png, png] },
  ]);
  expect(both).toMatchObject({ ok: false, reason: "video_and_images" });
  expect(notAnImage).toMatchObject({ ok: false, reason: "unknown_media" });
  expect(five).toMatchObject({ ok: false, reason: "too_many_images" });
});

test("an X account connected before video asks for a reconnect to post video, and still posts text", async () => {
  clock.at = new Date("2026-11-02T09:00:00Z");
  const id = await postStep();
  const mediaId = await upload(video(MiB));
  const [older, text, newer] = await draft(id, [
    { ...(await account("x", ["tweet.write"])), text: "Clip", mediaId },
    { ...(await account("x", ["tweet.write"])), text: "Words only" },
    { ...(await account("x", ["tweet.write", "media.write"])), text: "Clip again", mediaId },
  ]);
  expect(older).toMatchObject({ ok: false, reason: "reconnect_for_video" });
  expect(text).toMatchObject({ ok: true, mode: "publish" });
  expect(newer).toMatchObject({ ok: true, mode: "publish" });
});

test("Threads fetches the video where Direx has a public address; on localhost it becomes a hand post", async () => {
  clock.at = new Date("2026-11-02T09:00:00Z");
  th.reset();
  const id = await postStep();
  const mediaId = await upload(video(MiB));
  const [published] = await draft(id, [{ ...(await account("threads", ["threads_content_publish"])), text: "Clip", mediaId }]);
  expect(published).toMatchObject({ ok: true, mode: "publish" });
  expect((await approve(published!.itemId)).status).toBe(200);
  await dispatch(published!.itemId);
  expect(await actionOf(published!.itemId)).toMatchObject({ state: "sent", result: { url: "https://www.threads.com/@ana/post/abc" } });
  // Threads read the approved file through the link, as it would from a public Direx.
  expect(th.fetched).toEqual([MiB]);

  baseUrl = "http://localhost:3000";
  const later = await postStep();
  const [hand] = await draft(later, [{ ...(await account("threads", ["threads_content_publish"])), text: "Clip", mediaId }]);
  expect(hand).toMatchObject({ ok: true, mode: "manual" });
  expect(await payloadOf(hand!.itemId)).toMatchObject({ video: { mediaId, fileName: "launch.mp4" } });
  baseUrl = "https://direx.example.com";
});

test("a step's posts list the video each carries, with its name on a hand post", async () => {
  clock.at = new Date("2026-11-02T09:00:00Z");
  const id = await postStep();
  const mediaId = await upload(video(MiB), "Demo.mp4");
  await draft(id, [
    { ...(await linkedin()), text: "Clip", mediaId },
    { connection: "instagram", credentialId: null, networkId: null, text: "Clip", mediaId },
    { ...(await linkedin()), text: "Words" },
  ]);
  const list = await posts.list(W, id, "launch");
  expect(list.map((p) => [p.connection, p.video])).toEqual(expect.arrayContaining([
    ["linkedin", { mediaId, fileName: null }],
    ["instagram", { mediaId, fileName: "Demo.mp4" }],
    ["linkedin", null],
  ]));
  expect(list).toHaveLength(3);
});

/** A finished clip run on the step's recording, with one clip per media id, as the clip engine stores them. */
async function clipsOf(mediaIds: string[]) {
  const [run] = await q("insert into clip_runs (workspace_id, source_media_id, state, started_by, created_at, updated_at) values ($1, $2, 'done', $3, now(), now()) returning id", [W, mediaIds[0], owner]);
  const ids: string[] = [];
  for (const [position, mediaId] of mediaIds.entries()) {
    const [c] = await q("insert into clips (workspace_id, run_id, position, media_id, start_ms, end_ms, title, caption, citations, why, created_at) values ($1, $2, $3, $4, 0, 30000, 't', 'c', '[]', 'w', now()) returning id", [W, run.id, position, mediaId]);
    ids.push(c.id as string);
  }
  return ids;
}

test("a clips step puts two clips on one account as two posts, each its own Item, grouped per clip", async () => {
  clock.at = new Date("2026-11-02T09:00:00Z");
  li.reset();
  const id = await postStep();
  ok(await campaigns.setupStep(W, id, "launch", { type: "clips", touchClass: null, mailboxCredentialId: null, audience: "everyone" }));
  const a = await linkedin();
  const media = [await upload(video(MiB, "isom", 1)), await upload(video(MiB, "isom", 2))];
  const [c1, c2] = await clipsOf(media);
  const fact = ok(await facts.set(W, { field: "price", subject: `clips-${crypto.randomUUID()}`, value: "Setup in a day", source: { kind: "person", label: "Sam" }, confidence: "high", actor: { userId: owner } }));
  const version = (await q("select current_version from facts where id = $1", [fact.id]))[0].current_version as number;
  const step = { campaignId: id, stepKey: "launch", title: "Launch clip", plannedAt: WHEN };
  const NEXT_DAY = new Date(WHEN.getTime() + 86_400_000);
  const targets = [
    { ...a, text: "Setup takes a day.", mediaId: media[0]!, clipId: c1!, at: WHEN, citations: [{ factId: fact.id, version }] },
    { ...a, text: "Book a demo.", mediaId: media[1]!, clipId: c2!, at: NEXT_DAY },
  ];
  const results = await posts.draft(W, step, targets, owner);
  expect(results.map((r) => [r.ok, r.mode])).toEqual([[true, "publish"], [true, "publish"]]);
  const [one, two] = results.map((r) => r.itemId!);
  expect(one).not.toBe(two);
  const rows = await q("select i.group_key, i.planned_at, a.idempotency_key, i.snapshot from items i join actions a on a.id = i.action_id where i.id = any($1) order by i.planned_at", [[one, two]]);
  expect(rows.map((r) => [r.group_key, r.planned_at.toISOString(), r.idempotency_key])).toEqual([
    [`campaign:${id}:step:launch:clip:${c1}`, WHEN.toISOString(), `social:${id}:launch:linkedin:${a.networkId}:${c1}`],
    [`campaign:${id}:step:launch:clip:${c2}`, NEXT_DAY.toISOString(), `social:${id}:launch:linkedin:${a.networkId}:${c2}`],
  ]);
  expect(rows[0].snapshot).toEqual(expect.arrayContaining([{ kind: "fact", id: fact.id, version: String(version) }]));

  // Writing one clip's post again finds that post, not its sibling on the same account.
  expect((await posts.draft(W, step, [targets[0]!], owner))[0]!.itemId).toBe(one);

  // The Fact the first clip cites changes after approval: it is held and LinkedIn never hears of it.
  expect((await approve(one!)).status).toBe(200);
  ok(await facts.set(W, { field: "price", subject: (await q("select subject from facts where id = $1", [fact.id]))[0].subject, value: "Setup in two days", source: { kind: "person", label: "Sam" }, confidence: "high", actor: { userId: owner } }));
  await dispatch(one!);
  expect(await q("select state, hold_reason from actions where id = $1", [await items.actionIdOf(W, one!)])).toEqual([{ state: "held", hold_reason: "snapshot_changed" }]);
  expect(li.paths()).not.toContain("/rest/posts");

  // The other clip relies on nothing that moved, and posts.
  expect((await approve(two!)).status).toBe(200);
  clock.at = new Date(NEXT_DAY.getTime() + 60_000);
  await ledger.run(W, (await items.actionIdOf(W, two!))!);
  expect((await actionOf(two!)).state).toBe("sent");
});

test("a clips step: one recording becomes clips, each on one account at its time, approved per clip and posted", async () => {
  clock.at = new Date("2026-11-02T09:00:00Z");
  li.reset();
  const id = await postStep();
  ok(await campaigns.setupStep(W, id, "launch", { type: "clips", touchClass: null, mailboxCredentialId: null, audience: "everyone" }));
  const a = await linkedin();
  const insta = { connection: "instagram", credentialId: null, networkId: null };
  const source = ok(await files.upload({ workspaceId: W, userId: owner, kind: "source", fileName: "Talk.mp4", declaredBytes: MiB, body: new Response(video(MiB, "isom", 77)).body })).media.id;
  const fact = ok(await facts.set(W, { field: "price", subject: `step-${crypto.randomUUID()}`, value: "$49", source: { kind: "person", label: "Sam" }, confidence: "high", actor: { userId: owner } }));
  const version = (await q("select current_version from facts where id = $1", [fact.id]))[0].current_version as number;
  const moment = (startMs: number, caption: string) => ({ startMs, endMs: startMs + 30_000, title: caption, caption, citations: [`${fact.id}@${version}`], measureKey: null, why: "It states the price." });
  script = { schemaVersion: 1, moments: [moment(10_000, "One"), moment(50_000, "Two"), moment(90_000, "Three")] };

  expect(await campaigns.makeClips(W, id, "launch", { sourceMediaId: crypto.randomUUID(), accounts: [a], firstAt: WHEN }, owner)).toEqual({ ok: false, reason: "not_found" });
  const made = ok(await campaigns.makeClips(W, id, "launch", { sourceMediaId: source, accounts: [a, insta], firstAt: WHEN }, owner));
  expect(await campaigns.makeClips(W, id, "launch", { sourceMediaId: source, accounts: [a], firstAt: WHEN }, owner)).toEqual({ ok: false, reason: "in_progress" });
  expect(ok(await campaigns.clipStep(W, id, "launch"))).toMatchObject({ recordings: [{ run: { state: "queued" }, clips: [] }], lastAccounts: [a, insta] });

  await clips.transcribeStage({ workspaceId: W, runId: made.runId });
  await clips.cutStage({ workspaceId: W, runId: made.runId });

  // The call back drafted them: clips in the agent's order, round robin, the second LinkedIn clip a day later.
  const view = ok(await campaigns.clipStep(W, id, "launch")).recordings[0]!;
  expect(view.run).toMatchObject({ state: "done", failure: null });
  const placed = view.clips.map((c) => [c.caption, c.posts.map((p) => `${p.connection}:${p.mode}`)]);
  expect(placed).toEqual([["One", ["linkedin:publish"]], ["Two", ["instagram:manual"]], ["Three", ["linkedin:publish"]]]);
  const itemOf = (i: number) => view.clips[i]!.posts[0]!.itemId;
  const when = await q("select id, planned_at, group_key from items where id = any($1)", [[itemOf(0), itemOf(2)]]);
  expect(when.find((r) => r.id === itemOf(2)).planned_at.toISOString()).toBe(new Date(WHEN.getTime() + 86_400_000).toISOString());
  expect(when.find((r) => r.id === itemOf(0)).group_key).toBe(`campaign:${id}:step:launch:clip:${view.clips[0]!.id}`);
  expect(await payloadOf(itemOf(1))).toMatchObject({ text: "Two", video: { mediaId: view.clips[1]!.mediaId } });
  // Reading again drafts nothing twice.
  expect(ok(await campaigns.clipStep(W, id, "launch")).recordings[0]!.clips.flatMap((c) => c.posts)).toHaveLength(3);

  // One press approves the first clip's post; it posts that clip's own bytes.
  const clean = await call(`/api/w/${W}/items/approve-clean`, cookie, { method: "POST", body: { items: [{ id: itemOf(0), revision: await revisionOf(itemOf(0)) }] } });
  expect(clean.status).toBe(200);
  await dispatch(itemOf(0));
  expect((await actionOf(itemOf(0))).state).toBe("sent");
  expect((await actionOf(itemOf(0))).spec.media).toEqual([expect.objectContaining({ mediaId: view.clips[0]!.mediaId })]);
  expect(li.calls.filter((c) => c.path.startsWith("/upload/")).reduce((n, c) => n + c.bytes, 0)).toBe(MiB);

  // A new caption for the third clip drafts only its post again.
  const edited = ok(await campaigns.editClipCaption(W, id, "launch", view.clips[2]!.id, "Three, said better"));
  expect(edited.results).toEqual([expect.objectContaining({ ok: true, itemId: itemOf(2) })]);
  expect(String((await actionOf(itemOf(2))).spec.text)).toBe("Three, said better");

  // The price moves: the hand post, which nothing can hold, is warned about when the step is read.
  ok(await facts.set(W, { field: "price", subject: (await q("select subject from facts where id = $1", [fact.id]))[0].subject, value: "$59", source: { kind: "person", label: "Sam" }, confidence: "high", actor: { userId: owner } }));
  await campaigns.clipStep(W, id, "launch");
  expect((await q("select warnings from items where id = $1", [itemOf(1)]))[0].warnings).toEqual([expect.objectContaining({ code: "changed_since_drafted" })]);

  // A second recording on the same step, a day later: LinkedIn already posts on the first two days, so
  // its clips go on the days after, and the first recording's posts stay as they were.
  const now59 = (await q("select current_version from facts where id = $1", [fact.id]))[0].current_version as number;
  const fresh = (startMs: number, caption: string) => ({ ...moment(startMs, caption), citations: [`${fact.id}@${now59}`] });
  script = { schemaVersion: 1, moments: [fresh(10_000, "Four"), fresh(50_000, "Five")] };
  const later = new Date(WHEN.getTime() + 86_400_000);
  const second = ok(await campaigns.makeClips(W, id, "launch", { sourceMediaId: source, accounts: [a], firstAt: later }, owner));
  expect(await campaigns.makeClips(W, id, "launch", { sourceMediaId: source, accounts: [a], firstAt: later }, owner)).toEqual({ ok: false, reason: "in_progress" });
  await clips.transcribeStage({ workspaceId: W, runId: second.runId });
  await clips.cutStage({ workspaceId: W, runId: second.runId });
  const both = ok(await campaigns.clipStep(W, id, "launch"));
  expect(both.recordings.map((r) => r.run?.id)).toEqual([second.runId, made.runId]);
  expect(both.recordings[0]!.run).toMatchObject({ state: "done", failure: null });
  expect(both.lastAccounts).toEqual([a]);
  const newer = both.recordings[0]!.clips.map((c) => c.posts[0]!.itemId);
  const planned = await q("select id, planned_at from items where id = any($1)", [newer]);
  expect(newer.map((i) => planned.find((r) => r.id === i).planned_at.toISOString())).toEqual([2, 3].map((d) => new Date(WHEN.getTime() + d * 86_400_000).toISOString()));
  expect(both.recordings[1]!.clips.map((c) => c.posts.map((p) => p.itemId))).toEqual(view.clips.map((c) => c.posts.map((p) => p.itemId)));
  expect((await actionOf(itemOf(0))).state).toBe("sent");
  expect(String((await actionOf(itemOf(2))).spec.text)).toBe("Three, said better");
});

test("a clips step that isn't one, and clipping with no engine here, are refused", async () => {
  const id = await postStep();
  expect(await campaigns.clipStep(W, id, "launch")).toEqual({ ok: false, reason: "not_a_clips_step" });
  const none = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, posts: () => posts, startDraft: () => async () => ({ ok: false, reason: "not_here" }), now });
  expect(await none.makeClips(W, id, "launch", { sourceMediaId: crypto.randomUUID(), accounts: [], firstAt: WHEN }, owner)).toEqual({ ok: false, reason: "not_available" });
});
