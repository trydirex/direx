// SPDX-License-Identifier: AGPL-3.0-only
// createApp wires its routes to the worker it is handed, and hands the worker back the server's own
// modules through its ports (ADR 0027 rule 001). Before the worker starts, what needs it says so.
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../main";
import { campaignDefinitions } from "../modules/campaigns/index";
import { TEST_SECRET, testIdentity } from "../modules/identity/test-auth";
import { recordedBoss } from "./fixtures/boss";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
process.env.DIREX_MASTER_KEY = "11".repeat(32);
const { signIn, createOrg } = testIdentity();
afterEach(() => vi.unstubAllEnvs());

type Worker = NonNullable<ReturnType<Parameters<typeof createApp>[0]["worker"]>>;
const company = { id: "c1", name: "Acme", domain: "acme.test", state: "kept", score: 3 };
const fakeWorker = (over: Record<string, unknown> = {}) =>
  ({
    prospectingRuns: { companies: vi.fn(async () => ({ companies: [company] })) },
    agents: { start: vi.fn(async () => ({ ok: true, runId: "r1" })), report: vi.fn(), capsLeft: vi.fn() },
    ...over,
  }) as unknown as Worker;

const cookie = await signIn();
const ws = (await createOrg(cookie, "Ports")).workspace.id;
const post = (app: ReturnType<typeof createApp>["app"], path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

test("the ports read the server's own modules, and the worker's once it has started", async () => {
  let worker: Worker | undefined;
  const { app, ports } = createApp({ worker: () => worker });
  const plan = (await (await post(app, `/api/w/${ws}/plans`, { title: "Spring" })).json()) as { id: string };
  expect(await ports.startSources.plans(ws)).toEqual([{ id: plan.id, title: "Spring", currentVersion: null }]);
  expect(await ports.planMeasures(ws, crypto.randomUUID())).toBeNull();
  expect(await ports.startSources.media(ws)).toEqual([]);
  expect(ports.media()).toHaveProperty("sources");
  expect(await ports.startSources.seoPages(ws)).toMatchObject({ ok: false });
  // No worker yet: no companies, rather than a refusal.
  expect(await ports.startSources.companies(ws)).toEqual([]);
  worker = fakeWorker();
  expect(await ports.startSources.companies(ws)).toEqual([{ id: "c1", name: "Acme", domain: "acme.test", state: "kept" }]);
  expect(worker.prospectingRuns.companies).toHaveBeenCalledWith(ws);
});

test("Ask's starts include clipping only once the worker has clip runs, and never on cloud", async () => {
  let worker: Worker | undefined;
  const { ports } = createApp({ worker: () => worker });
  const starts = ports.askStarts(recordedBoss().boss as never);
  const ids = () => starts().map((s) => s.id);
  expect(ids()).not.toContain("pick_clips");
  expect(ids().length).toBeGreaterThan(0);
  worker = fakeWorker({ clips: {} });
  vi.stubEnv("DIREX_DEPLOYMENT", "self_host");
  expect(ids()).toContain("pick_clips");
  vi.stubEnv("DIREX_DEPLOYMENT", "cloud");
  expect(ids()).not.toContain("pick_clips");
});

test("a route that needs the worker refuses before it starts, and reaches it after", async () => {
  let worker: Worker | undefined;
  const { app, ports } = createApp({ worker: () => worker });
  const rules = () => app.request(`/api/w/${ws}/standing-rules`, { headers: { cookie } });
  expect((await rules()).status).toBe(500);
  worker = fakeWorker({ standingRules: { list: vi.fn(async () => []) }, lessons: { propose: vi.fn(async () => ({ ok: false, reason: "not_found" })) } });
  expect((await rules()).status).toBe(200);
  expect(worker.standingRules.list).toHaveBeenCalledWith(ws);
  await post(app, `/api/w/${ws}/lessons`, { agent: "recipient_writer", text: "Keep it short." });
  expect(worker.lessons.propose).toHaveBeenCalledWith(ws, expect.objectContaining({ definitionVersion: campaignDefinitions.recipient_writer.version }));
  // The worker builds next steps on its own queue, and a finished clip run reaches campaigns.
  expect(ports.nextSteps(recordedBoss().boss as never)).toHaveProperty("work");
  await expect(ports.clipStepDone(ws, crypto.randomUUID())).resolves.toBeUndefined();
});

test("a stored key is checked and read through the worker's plugins, and its list is read at once", async () => {
  const plugins = {
    installedKeyServices: () => [{ connection: "acme", name: "Acme" }],
    queryTyped: vi.fn(async () => ({ name: "Weekly", subscriberCount: 42 })),
    query: vi.fn(async () => ({ name: "Weekly", subscriberCount: 42 })),
  };
  const worker = fakeWorker({ plugins, syncNewsletter: vi.fn(async () => {}) });
  const { app } = createApp({ worker: () => worker });
  const owner = await signIn();
  const w = (await createOrg(owner, "Keys")).workspace.id;
  const send = (method: string, path: string, body?: unknown) =>
    app.request(`/api/w/${w}${path}`, { method, headers: { cookie: owner, "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const services = ((await (await send("GET", "/key-services")).json()) as { services: { connection: string; canCheck: boolean }[] }).services;
  expect(services).toContainEqual(expect.objectContaining({ connection: "acme", canCheck: false }));
  const stored = await send("POST", "/key-services/kit", { key: "kit-key" });
  expect(stored.status).toBe(201);
  const credentialId = ((await stored.json()) as { credential: { id: string } }).credential.id;
  expect(plugins.queryTyped).toHaveBeenCalledWith(w, "com.trydirex.kit/newsletter.profile", null, { key: "kit-key" });
  expect(worker.syncNewsletter).toHaveBeenCalledWith(w, credentialId, "kit");
  expect((await send("POST", "/key-services/kit/check")).status).toBe(200);
  expect(plugins.query).toHaveBeenCalledWith(w, "com.trydirex.kit/newsletter.profile", null, credentialId);
  await send("PUT", "/newsletter/settings", { list: "connected", credentialId, weekday: 1, sendTime: "09:00", timeZone: "UTC", enabled: false });
  expect(((await (await send("GET", "/newsletter/settings")).json()) as { subscriberCount: number | null }).subscriberCount).toBe(42);
});

test("uploads go under the data directory, and the server says whether it is claimed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "direx-app-media-"));
  vi.stubEnv("DIREX_DATA_DIR", dir);
  const { app } = createApp({ worker: () => undefined });
  const body = new Uint8Array(64);
  body.set([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom")]);
  const up = await app.request(`/api/w/${ws}/media?kind=source`, { method: "POST", headers: { cookie, "content-type": "video/mp4", "x-file-name": "talk.mp4" }, body });
  expect(up.status).toBe(201);
  expect(await readdir(join(dir, "media"))).not.toHaveLength(0);
  expect((await app.request("/api/media-links/not-a-token")).status).toBe(404);
  expect((await app.request("/api/server/status", { headers: { cookie } })).status).toBe(200);
});

test("anyone can ask where this server's source is: Direx's own, the release it runs, or the address a changed Direx names", async () => {
  const { app } = createApp({ worker: () => undefined });
  const where = async () => {
    const r = await app.request("/api/source");
    return [r.status, r.headers.get("location")];
  };
  expect(await where()).toEqual([302, "https://github.com/trydirex/direx"]);
  vi.stubEnv("DIREX_VERSION", "local");
  expect(await where()).toEqual([302, "https://github.com/trydirex/direx"]);
  vi.stubEnv("DIREX_VERSION", "v0.1.0");
  expect(await where()).toEqual([302, "https://github.com/trydirex/direx/tree/v0.1.0"]);
  vi.stubEnv("DIREX_SOURCE_URL", "https://git.example.com/our-direx");
  expect(await where()).toEqual([302, "https://git.example.com/our-direx"]);
});
