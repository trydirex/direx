// SPDX-License-Identifier: AGPL-3.0-only
// Services connected by a pasted API key: only an Owner or Admin with a recent sign-in connects
// or replaces one, the service is asked about a typed key before it is stored, it lands as the
// Workspace's credential on that connection, and the key never comes back in a response or a
// log line, even when the service's refusal repeats it.
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { masterRootKey } from "./adapters/crypto";
import { createVault } from "./application/secrets";
import type { KeyConnect } from "./routes";
import { testApp, vaultDb } from "./test-helpers";

const db = vaultDb();
const vault = createVault({ rootKey: masterRootKey(Buffer.alloc(32, 7)), now: () => new Date() });
const FAKE_KEY = "not-a-real-key";
const BAD_KEY = "refused-fake-key";
const checked: unknown[] = [];
let refuse = false;
const connectedCalls: [string, string, string][] = [];
let connectedFails = false;
const keys: KeyConnect = {
  connected: async (ws, connection, credentialId) => {
    connectedCalls.push([ws, connection, credentialId]);
    if (connectedFails) throw new Error("the worker is not running");
  },
  services: () => [
    { connection: "checker", name: "Checker", canCheck: true },
    { connection: "plain", name: "Plain", canCheck: false },
    // An installed plugin's connection, stored under its id (ADR 0026 rule 008).
    { connection: "com.example.hello:hello", name: "Hello", canCheck: false },
  ],
  check: async (_ws, _connection, key) => {
    checked.push(key);
    if (refuse || ("typed" in key && key.typed === BAD_KEY)) throw new Error(`the service refused ${"typed" in key ? key.typed : FAKE_KEY}`);
    return { remainingCredits: 120 };
  },
};
const { call, signIn, workspace } = testApp(vault, "http://direx.test", undefined, keys);
afterEach(() => vi.useRealTimers());
afterAll(() => db.close());

async function member(ws: string, role: string) {
  const m = await signIn();
  await db.addMember(ws, m.userId, role);
  return m;
}
const connect = (ws: string, cookie: string, connection = "checker", key = FAKE_KEY) => call(`/api/w/${ws}/key-services/${connection}`, cookie, { method: "POST", body: { key } });
const replace = (ws: string, cookie: string, key: string, connection = "checker") => call(`/api/w/${ws}/key-services/${connection}`, cookie, { method: "PUT", body: { key } });
const check = (ws: string, cookie: string, connection = "checker") => call(`/api/w/${ws}/key-services/${connection}/check`, cookie, { method: "POST" });
const error = async (res: Response) => [res.status, ((await res.json()) as { error: string }).error];

test("storing or replacing a key tells the composition root, and its failure never fails the connect", async () => {
  const { ws, owner } = await workspace();
  const before = connectedCalls.length;
  const res = await connect(ws, owner.cookie);
  const id = ((await res.json()) as { credential: { id: string } }).credential.id;
  expect(connectedCalls.slice(before)).toEqual([[ws, "checker", id]]);
  expect((await replace(ws, owner.cookie, "another-fake-key")).status).toBe(200);
  expect(connectedCalls.slice(before)).toEqual([[ws, "checker", id], [ws, "checker", id]]);
  // A refused key is never stored, so nothing is told.
  await connect(ws, owner.cookie, "checker", BAD_KEY);
  expect(connectedCalls.slice(before)).toHaveLength(2);
  connectedFails = true;
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await connect(ws, owner.cookie, "plain")).status).toBe(201);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("after connecting plain"));
  } finally {
    connectedFails = false;
    error.mockRestore();
  }
});

test("everyone in the Workspace sees which services take a key", async () => {
  const { ws } = await workspace();
  const viewer = await member(ws, "viewer");
  const res = await call(`/api/w/${ws}/key-services`, viewer.cookie);
  expect(await res.json()).toEqual({ services: keys.services() });
  expect((await call(`/api/w/${ws}/key-services`)).status).toBe(401);
});

test("only an Owner or Admin connects a key, once, as the Workspace's credential on that service", async () => {
  const { ws, owner } = await workspace();
  const marketer = await member(ws, "marketer");
  const viewer = await member(ws, "viewer");
  const admin = await member(ws, "admin");
  expect(await error(await connect(ws, marketer.cookie))).toEqual([403, "forbidden"]);
  expect(await error(await connect(ws, viewer.cookie))).toEqual([403, "forbidden"]);
  expect(await error(await connect(ws, admin.cookie, "nope"))).toEqual([404, "unknown_connection"]);

  const refused = await connect(ws, admin.cookie, "checker", BAD_KEY);
  const refusedBody = await refused.text();
  expect([refused.status, JSON.parse(refusedBody)]).toEqual([422, { error: "check_failed" }]);
  expect(refusedBody).not.toContain(BAD_KEY);
  expect(await (await call(`/api/w/${ws}/credentials`, admin.cookie)).json()).toEqual({ credentials: [] });

  const res = await connect(ws, admin.cookie);
  expect(res.status).toBe(201);
  expect(checked.at(-1)).toEqual({ typed: FAKE_KEY });
  const text = await res.text();
  expect(text).not.toContain(FAKE_KEY);
  expect(JSON.parse(text)).toMatchObject({ credential: { scope: "workspace", kind: "api_key", connection: "checker", name: "Checker", ownerUserId: null, status: "active" } });
  expect(await error(await connect(ws, owner.cookie))).toEqual([409, "duplicate_key"]);
  // A service with nothing to ask takes the key as typed.
  const asked = checked.length;
  expect((await connect(ws, owner.cookie, "plain", BAD_KEY)).status).toBe(201);
  expect(checked.length).toBe(asked);

  const listed = await (await call(`/api/w/${ws}/credentials`, viewer.cookie)).text();
  expect(listed).not.toContain(FAKE_KEY);
});

test("connecting a key needs a recent sign-in", async () => {
  const { ws } = await workspace();
  const admin = await member(ws, "admin");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 11 * 60_000);
  expect(await error(await connect(ws, admin.cookie))).toEqual([403, "step_up_required"]);
  expect(await error(await replace(ws, admin.cookie, FAKE_KEY))).toEqual([403, "step_up_required"]);
});

test("checking asks the service about the stored key; a refusal says only that it failed, and nothing logs the key", async () => {
  const { ws, owner } = await workspace();
  const marketer = await member(ws, "marketer");
  const lines: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args) => void lines.push(...args));

  expect(await error(await check(ws, owner.cookie))).toEqual([404, "missing"]);
  const stored = ((await (await connect(ws, owner.cookie)).json()) as { credential: { id: string; version: number } }).credential;
  expect(await error(await check(ws, marketer.cookie))).toEqual([403, "forbidden"]);
  expect(await error(await check(ws, owner.cookie, "plain"))).toEqual([404, "unknown_connection"]);

  const ok = await check(ws, owner.cookie);
  expect(await ok.json()).toEqual({ remainingCredits: 120 });
  expect(checked.at(-1)).toEqual({ credentialId: stored.id });

  refuse = true;
  const failed = await check(ws, owner.cookie);
  const body = await failed.text();
  expect([failed.status, JSON.parse(body)]).toEqual([422, { error: "check_failed" }]);
  expect(body).not.toContain(FAKE_KEY);
  refuse = false;

  // A replacement is asked about first too; a refused one leaves the stored key as it was.
  expect(await error(await replace(ws, marketer.cookie, FAKE_KEY))).toEqual([403, "forbidden"]);
  const badReplace = await replace(ws, owner.cookie, BAD_KEY);
  const badBody = await badReplace.text();
  expect([badReplace.status, JSON.parse(badBody)]).toEqual([422, { error: "check_failed" }]);
  expect(badBody).not.toContain(BAD_KEY);
  const unchanged = (await (await call(`/api/w/${ws}/credentials`, owner.cookie)).json()) as { credentials: { id: string; version: number }[] };
  expect(unchanged.credentials).toMatchObject([{ id: stored.id, version: stored.version }]);
  const replaced = await replace(ws, owner.cookie, `${FAKE_KEY}-2`);
  expect(replaced.status).toBe(200);
  expect(await replaced.text()).not.toContain(FAKE_KEY);
  expect(checked.at(-1)).toEqual({ typed: `${FAKE_KEY}-2` });
  expect(await error(await replace(ws, owner.cookie, FAKE_KEY, "nope"))).toEqual([404, "unknown_connection"]);

  // Disconnecting is the vault's own route.
  expect((await call(`/api/w/${ws}/credentials/${stored.id}`, owner.cookie, { method: "DELETE" })).status).toBe(200);
  expect(await error(await check(ws, owner.cookie))).toEqual([404, "missing"]);

  expect(await error(await replace(ws, owner.cookie, FAKE_KEY))).toEqual([404, "missing"]);
  expect(JSON.stringify(lines)).not.toContain(FAKE_KEY);
  expect(JSON.stringify(lines)).not.toContain(BAD_KEY);
  vi.restoreAllMocks();
});

test("an installed plugin's key is stored under its own id, and the vault hands it only to that plugin's connection (ADR 0026 rule 008)", async () => {
  const { ws, owner } = await workspace();
  const res = await connect(ws, owner.cookie, "com.example.hello:hello");
  expect(res.status).toBe(201);
  const { credential } = (await res.json()) as { credential: { id: string; connection: string } };
  expect(credential.connection).toBe("com.example.hello:hello");

  const use = (connections?: string[]) => vault.credentials(ws, credential.id, { consumer: "query", ...(connections && { connections }) });
  expect(await use(["com.example.hello:hello"])).toEqual({ key: FAKE_KEY });
  // Another plugin asking for it, even under the same key name, gets nothing, and the refusal is recorded.
  expect(await use(["com.example.other:hello"])).toBeNull();
  expect(await use(["hello"])).toBeNull();
  const events = await vault.events(ws, credential.id);
  expect(events.map((e: { outcome: string; errorCode: string | null }) => [e.outcome, e.errorCode])).toContainEqual(["refused", "wrong_connection"]);
  // A first-party call names no connections, as before.
  expect(await use()).toEqual({ key: FAKE_KEY });
});

test("a key connection is a plain name or exactly `<plugin id>:<name>`", async () => {
  const { ws, owner } = await workspace();
  for (const bad of ["com.example.hello%2Fhello", "a:b", "com.example.hello:", ":hello", "com.example.hello:hello:x"]) {
    expect((await connect(ws, owner.cookie, bad)).status, bad).toBe(400);
  }
  expect(await error(await connect(ws, owner.cookie, "com.example.other:hello"))).toEqual([404, "unknown_connection"]);
});
