// SPDX-License-Identifier: AGPL-3.0-only
// A clip run from upload to clips over HTTP: the real media module on disk, a real queue, ffprobe and
// ffmpeg for real in the sandbox. whisper stands in with words at fixed times, and the picker is scripted:
// it hands its moments to the sink as an agent run would. Facts and plan measures are stand-ins too.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { createBoss } from "../../jobs/boss";
import { sandboxStatus } from "../models/index";
import { createMedia, diskStore, mediaRoutes } from "../media/index";
import { mediaRows, TEST_SECRET, testIdentity } from "../media/fixtures/support";
import { clipAskStarts, clipRoutes, createClips, cut, FAILURES, MOMENTS_OUTPUT_KEY, probe, toWav, type Engine, type PickInput, type Word } from "./index";
import type { MomentsOutput } from "./definitions/clip-picker";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const dir = await mkdtemp(join(tmpdir(), "direx-clip-runs-"));
const boss = createBoss();
await boss.start();
afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await rm(dir, { recursive: true, force: true });
});

const FACT = "00000000-0000-4000-8000-0000000000f1";
const PLAN = "00000000-0000-4000-8000-0000000000a1";
const ffmpeg = Bun.which("ffmpeg");
const ffprobe = Bun.which("ffprobe");
const sandbox = await sandboxStatus();
const ready = Boolean(ffmpeg && ffprobe && sandbox.ok);

/** One word every 500 ms over the first 60 s, a sentence every ten words. */
const words: Word[] = Array.from({ length: 120 }, (_, i) => ({ startMs: i * 500, endMs: i * 500 + 400, text: i % 10 === 9 ? `w${i}.` : `w${i}` }));
const moment = (startMs: number, endMs: number, citations: string[], measureKey: string | null = null) => ({ startMs, endMs, title: "Setup in a day", caption: "We set you up in a day.", citations, measureKey, why: "It states the offer." });

// What the picker hands over next, and what its agent run reports, set by each test.
let script: MomentsOutput | null = null;
let agentStatus: { status: string; reason: string | null } = { status: "running", reason: null };
let tooLong = false;
const picked: PickInput[] = [];

const engine: Engine = {
  findTools: () => (ready ? { ffmpeg: ffmpeg!, ffprobe: ffprobe!, whisper: "/nonexistent" } : { missing: ["ffmpeg"] }),
  probe: async (...a) => (tooLong ? { durationMs: 91 * 60_000, hasVideo: true, hasAudio: true } : probe(...a)),
  toWav,
  transcribe: async () => words,
  cut,
  ensureModel: async () => join(dir, "model.bin"),
};
const files = createMedia({ store: () => diskStore(join(dir, "media")), now: () => new Date() });
const clips = createClips({
  boss,
  media: () => files,
  facts: {
    usableFacts: async () => [{ id: FACT, version: 2, field: "offer", subject: "", value: "Setup in a day", digest: "d" }],
    checkCitation: async (_ws, id, version) => (id !== FACT ? "missing" : version === 2 ? "ok" : "stale"),
  },
  measures: async (_ws, planId) => (planId === PLAN ? [{ key: "demo_requests", label: "Demo requests", target: "20 a month" }] : null),
  startPick: () => async (workspaceId, a) => {
    picked.push(a.input);
    const body = script;
    const runId = crypto.randomUUID();
    // Handed over a moment later, as an agent run does once the model answers.
    if (body) setTimeout(() => void clips.sink(workspaceId, { kind: "draft", outputKey: MOMENTS_OUTPUT_KEY, body }, { runId, input: a.input, tainted: true, pagesRead: [], pages: [], producer: { agent: "clip_picker", definitionVersion: 1, promptDigest: "p", routeHash: "r" } }), 50);
    return { ok: true, runId };
  },
  agentRun: () => async () => agentStatus,
  dataDir: () => dir,
  engine,
});
await clips.work();

const { routes, signIn, createOrg, call } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", mediaRoutes({ media: () => files }));
(routes as unknown as OpenAPIHono).route("/", clipRoutes({ clips: () => clips }));
const owner = await signIn();
const W = (await createOrg(owner, "Clips")).workspace.id;
const userId = ((await (await call("/api/me", owner)).json()) as { user: { id: string } }).user.id;
const other = await signIn();
const W2 = (await createOrg(other, "Other")).workspace.id;

type Run = { id: string; state: string; failure: string | null; dropped: { reason: string }[]; clips: { mediaId: string; startMs: number; endMs: number; citations: string[]; caption: string }[] };
const start = (body: unknown, cookie = owner, w = W) => call(`/api/w/${w}/clip-runs`, cookie, { method: "POST", body });
const read = async (id: string) => ((await (await call(`/api/w/${W}/clip-runs/${id}`, owner)).json()) as { run: Run }).run;
const started = async (body: unknown) => ((await (await start(body)).json()) as { run: Run }).run;
/** Polls until the run is done or failed. */
async function finished(id: string): Promise<Run> {
  for (let i = 0; i < 600; i++) {
    const run = await read(id);
    if (run.state === "done" || run.state === "failed") return run;
    await Bun.sleep(200);
  }
  throw new Error(`run ${id} didn't finish`);
}
async function upload(path: string) {
  const r = await routes.request(`/api/w/${W}/media?kind=source`, { method: "POST", headers: { cookie: owner, "content-type": "video/mp4", "x-file-name": "talk.mp4" }, body: Bun.file(path) });
  expect(r.status).toBe(201);
  return ((await r.json()) as { media: { id: string } }).media.id;
}

test("Ask's pick clips refuses a video that isn't here, before and after it is accepted", async () => {
  const ask = clipAskStarts({ clips: () => clips, media: () => files })[0]!;
  expect(await ask.check(W, { mediaId: crypto.randomUUID() })).toEqual({ ok: false, why: "not_found" });
  expect(await ask.start(W, { mediaId: crypto.randomUUID() }, { userId, key: "item-0", tainted: false })).toEqual({ ok: false, why: "not_found" });
  expect(await ask.report(W, { kind: "clip_run", id: crypto.randomUUID() })).toBeNull();
});

test("a missing video, a plan that isn't there, and a malformed id are refused", async () => {
  const missing = await start({ mediaId: crypto.randomUUID() });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "not_found" });
  expect((await call(`/api/w/${W}/clip-runs/${crypto.randomUUID()}`, owner)).status).toBe(404);
  expect((await start({ mediaId: "nope" })).status).toBe(400);
});

if (ready) {
  const source = join(dir, "talk.mp4");
  const silent = join(dir, "silent.mp4");
  expect(Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=65", "-f", "lavfi", "-i", "sine=frequency=440:duration=65", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", source]).exitCode).toBe(0);
  expect(Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=3", "-c:v", "libx264", "-preset", "ultrafast", silent]).exitCode).toBe(0);
  const mediaId = await upload(source);

  test("a plan that isn't approved here is refused", async () => {
    const r = await start({ mediaId, planId: crypto.randomUUID() });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "unknown_plan" });
  });

  test("a run transcribes, keeps the moment that cites a current Fact, drops the stale one with why, and cuts the clip", async () => {
    script = { schemaVersion: 1, moments: [moment(5_200, 26_100, [`${FACT}@2`]), moment(30_000, 55_000, [`${FACT}@1`])] };
    const r = await start({ mediaId, planId: PLAN });
    expect(r.status).toBe(202);
    const { run } = (await r.json()) as { run: Run };
    expect(run.state).toBe("queued");
    // One run at a time per video.
    expect(await (await start({ mediaId })).json()).toEqual({ error: "in_progress" });
    // Another Workspace can neither read it nor start one on this video.
    expect((await call(`/api/w/${W2}/clip-runs/${run.id}`, other)).status).toBe(404);
    expect((await start({ mediaId }, other, W2)).status).toBe(404);

    const done = await finished(run.id);
    expect(done).toMatchObject({ state: "done", failure: null, dropped: [{ reason: `cites ${FACT}@1, which has changed since that version` }] });
    expect(done.clips).toHaveLength(1);
    // Snapped out to the words it cut through.
    expect(done.clips[0]).toMatchObject({ startMs: 5_000, endMs: 26_400, citations: [`${FACT}@2`], caption: "We set you up in a day." });

    // The picker read the Facts by id and version, the plan's measure, and the timed transcript.
    const text = picked.at(-1)!.text;
    expect(text).toContain(`${FACT}@2: offer: Setup in a day`);
    expect(text).toContain("demo_requests: Demo requests (target: 20 a month)");
    expect(text).toContain("[0-4900] w0 w1 w2 w3 w4 w5 w6 w7 w8 w9.");
    expect(picked.at(-1)!.clipRunId).toBe(run.id);

    // The clip is in media as a clip, kept for the person who started the run, vertical and the length asked for.
    const row = (await mediaRows(W)).find((m) => m.id === done.clips[0]!.mediaId);
    expect(row).toMatchObject({ kind: "clip", uploadedBy: userId, fileName: "Setup in a day.mp4", contentType: "video/mp4" });
    const got = await routes.request(`/api/w/${W}/media/${row!.id}`, { headers: { cookie: owner } });
    expect(got.status).toBe(200);
    const path = join(dir, "clip.mp4");
    await Bun.write(path, got);
    const info = JSON.parse(Bun.spawnSync(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]).stdout.toString()) as { format: { duration: string }; streams: { codec_type: string; width?: number; height?: number }[] };
    expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ width: 1080, height: 1920 });
    expect(Number(info.format.duration)).toBeCloseTo(21.4, 1);
    // Nothing is left in the work directory.
    expect(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: join(dir, "clips"), onlyFiles: false }))).toEqual([]);
  }, 180_000);

  test("Ask's pick clips starts the button's clip run once, points a retry at it, and is done only when cut", async () => {
    script = { schemaVersion: 1, moments: [moment(5_200, 26_100, [`${FACT}@2`])] };
    const ask = clipAskStarts({ clips: () => clips, media: () => files })[0]!;
    expect(ask).toMatchObject({ id: "pick_clips", definition: "clip_picker", area: "social", permission: "item.edit" });
    expect(await ask.check(W, { mediaId })).toMatchObject({ ok: true, title: "Pick clips from talk.mp4" });
    const by = { userId, key: "item-1", tainted: true };
    const made = await ask.start(W, { mediaId }, by);
    if (!made.ok) throw new Error(made.why);
    expect(made.work.kind).toBe("clip_run");
    expect(await ask.check(W, { mediaId })).toEqual({ ok: false, why: "in_progress" });
    expect(await ask.start(W, { mediaId }, by)).toEqual(made);
    expect((await ask.report(W, made.work))?.state).not.toBe("done");
    expect((await finished(made.work.id)).state).toBe("done");
    expect(await ask.report(W, made.work)).toEqual({ state: "done", itemIds: [] });
    expect(await ask.report(W, { kind: "agent_run", id: made.work.id })).toBeNull();
  }, 180_000);

  test("when no moment checks out the run fails with the plain reason, keeping what was dropped", async () => {
    script = { schemaVersion: 1, moments: [moment(5_000, 26_000, []), moment(30_000, 55_000, [], "signups")] };
    const run = await finished((await started({ mediaId })).id);
    expect(run).toMatchObject({ state: "failed", failure: FAILURES.noMoment, clips: [] });
    expect(run.dropped.map((d) => d.reason)).toEqual(["backs no Fact or goal", "names signups, which isn't a measure in the plan"]);
  }, 60_000);

  test("a pick that ends without handing anything over fails the run with why", async () => {
    script = null;
    const run = await started({ mediaId });
    for (let i = 0; i < 300 && (await read(run.id)).state !== "picking"; i++) await Bun.sleep(100);
    expect((await read(run.id)).state).toBe("picking");
    agentStatus = { status: "timed_out", reason: "deadline" };
    expect(await read(run.id)).toMatchObject({ state: "failed", failure: "the moment picker stopped before it finished (deadline)" });
    agentStatus = { status: "running", reason: null };
  }, 60_000);

  test("a video over 90 minutes, or with no sound, is refused before transcription", async () => {
    const before = picked.length;
    tooLong = true;
    const long = await finished((await started({ mediaId })).id);
    tooLong = false;
    expect(long).toMatchObject({ state: "failed", failure: "this video is over 90 minutes" });
    const quiet = await finished((await started({ mediaId: await upload(silent) })).id);
    expect(quiet).toMatchObject({ state: "failed", failure: FAILURES.noAudio });
    expect(picked.length).toBe(before);
  }, 60_000);
} else {
  test("the clip run tests need ffmpeg, ffprobe and the sandbox", () => {
    console.warn(`clip run tests skipped: ${!ffmpeg || !ffprobe ? "ffmpeg or ffprobe is missing" : sandbox.ok ? "" : sandbox.reason}`);
  });
}
