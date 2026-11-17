// SPDX-License-Identifier: AGPL-3.0-only
// The door's app on its own, with real tokens, caps and request rows and fake reads: the registry
// matches the catalogue, the document lists the readers and nothing else, and each refusal answers
// as the door-reads spec says and leaves the row it should.
import { beforeAll, expect, test } from "vitest";
import { z } from "zod";
import type { DoorRead } from "../core-reads/index";
import { seedWorkspace } from "./fixtures/members";
import { createRequests, createTokens, DOOR_BASE, doorApp, registerReaders } from "./index";

const W = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const owner = crypto.randomUUID();
const otherOwner = crypto.randomUUID();
const tokens = createTokens({ maxDays: null });
const requests = createRequests({ caps: { perToken: 3, perWorkspace: 1000 } });

const Input = z.strictObject({ cursor: z.string().nullish() });
const fake = (disclosure: DoorRead["disclosure"], read?: DoorRead["read"]): DoorRead => ({
  description: "A fake read.",
  input: Input,
  output: z.object({ n: z.number() }),
  disclosure,
  read:
    read ??
    (async (_w, raw) => {
      const a = Input.parse(raw);
      return a.cursor === "bad" ? { ok: false, reason: "bad_cursor" } : { ok: true, value: { n: 1, secret: "a field the output doesn't name" }, trust: "trusted" };
    }),
});
const reads = {
  read_changes: fake("operational"),
  read_needs_you: fake("personal"),
  read_schedule: fake("personal"),
  read_campaign: fake("operational", async () => {
    throw new Error("boom");
  }),
};
const app = doorApp({ tokens, requests, registrations: registerReaders(reads) });

beforeAll(async () => {
  await seedWorkspace(W, owner);
  await seedWorkspace(OTHER, otherOwner);
});
async function token(readers: string[] = ["read_changes", "read_campaign"], w = W, by = owner) {
  const r = await tokens.create(w, { name: "Script", days: 7, readers, kinds: [] }, by);
  if (!r.ok) throw new Error(r.reason);
  return r;
}
const post = (reader: string, headers: Record<string, string>, body = "{}", w = W) => app.request(`${DOOR_BASE}/w/${w}/${reader}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const answer = async (res: Response) => [res.status, await res.json()];
const outcomes = async (tokenId: string) => (await requests.recent(W, tokenId)).map((r) => r.outcome);

test("the registry follows the catalogue: no reader missing or extra, and the same personal flags", () => {
  const { read_campaign: _gone, ...three } = reads;
  expect(() => registerReaders(three)).toThrow(/missing: read_campaign/);
  expect(() => registerReaders({ ...reads, read_vault: fake("operational") })).toThrow(/not in the catalogue: read_vault/);
  expect(() => registerReaders({ ...reads, read_needs_you: fake("operational") })).toThrow(/read_needs_you disagree/);
  expect(registerReaders(reads).map((r) => r.name)).toEqual(["read_changes", "read_needs_you", "read_schedule", "read_campaign"]);
});

test("the door's document lists the four readers and the MCP endpoint, and nothing else", async () => {
  const doc = (await (await app.request(`${DOOR_BASE}/openapi.json`)).json()) as { info: { version: string }; paths: Record<string, unknown> };
  expect(doc.info.version).toBe("1");
  expect(Object.keys(doc.paths).sort()).toEqual(["mcp", "read_campaign", "read_changes", "read_needs_you", "read_schedule"].map((n) => `${DOOR_BASE}/w/{workspaceId}/${n}`));
});

test("no token is 401 token_required, a session cookie included", async () => {
  expect(await answer(await post("read_changes", {}))).toEqual([401, { error: "token_required" }]);
  expect(await answer(await post("read_changes", { cookie: "better-auth.session_token=abc" }))).toEqual([401, { error: "token_required" }]);
  expect(await answer(await post("read_changes", { authorization: "Basic abc" }))).toEqual([401, { error: "token_required" }]);
});

test("every token that isn't live here gets the same 401, and leaves no row", async () => {
  const revoked = await token();
  await tokens.revoke(W, revoked.id, owner);
  const elsewhere = await token(["read_changes"], OTHER, otherOwner);
  const live = await token();
  const wrong = live.token.slice(0, -1) + (live.token.endsWith("A") ? "B" : "A");
  const answers = [
    await post("read_changes", bearer(revoked.token)),
    await post("read_changes", bearer(wrong)),
    await post("read_changes", bearer("dxt_short")),
    await post("read_changes", bearer(live.token), "{}", OTHER),
    await post("read_changes", bearer(elsewhere.token)),
  ];
  for (const res of answers) expect(await answer(res)).toEqual([401, { error: "invalid_token" }]);
  expect(await outcomes(revoked.id)).toEqual([]);
  expect(await outcomes(live.id)).toEqual([]);
});

test("a reader the token didn't choose is 403, counted and recorded", async () => {
  const t = await token(["read_changes"]);
  expect(await answer(await post("read_needs_you", bearer(t.token)))).toEqual([403, { error: "reader_not_allowed" }]);
  expect(await outcomes(t.id)).toEqual(["reader_not_allowed"]);
});

test("over the cap is 429 with Retry-After, and recorded", async () => {
  const t = await token();
  for (let i = 0; i < 3; i++) expect((await post("read_changes", bearer(t.token))).status).toBe(200);
  const res = await post("read_changes", bearer(t.token));
  expect(await answer(res)).toEqual([429, { error: "rate_limited" }]);
  expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await outcomes(t.id))[0]).toBe("rate_limited");
});

test("a body over 16 KB is 413; bad JSON, an unknown field and a bad cursor are 400; each is recorded", async () => {
  const t = await token();
  expect(await answer(await post("read_changes", bearer(t.token), JSON.stringify({ cursor: "x".repeat(17 * 1024) })))).toEqual([413, { error: "too_large" }]);
  expect(await answer(await post("read_changes", bearer(t.token), "{nope"))).toEqual([400, { error: "invalid_input" }]);
  const u = await token();
  expect(await answer(await post("read_changes", bearer(u.token), JSON.stringify({ everything: true })))).toEqual([400, { error: "invalid_input" }]);
  expect(await answer(await post("read_changes", bearer(u.token), JSON.stringify({ cursor: "bad" })))).toEqual([400, { error: "bad_cursor" }]);
  expect(await outcomes(t.id)).toEqual(["invalid_input", "too_large"]);
  expect(await outcomes(u.id)).toEqual(["bad_cursor", "invalid_input"]);
});

test("a read answers with its output's fields only, and leaves an ok row with no content", async () => {
  const t = await token();
  expect(await answer(await post("read_changes", bearer(t.token), ""))).toEqual([200, { n: 1 }]);
  const [row] = await requests.recent(W, t.id);
  expect(row).toEqual({ reader: "read_changes", outcome: "ok", at: expect.any(Date) });
});

test("a read that fails is 500 and recorded as error", async () => {
  const t = await token();
  expect((await post("read_campaign", bearer(t.token))).status).toBe(500);
  expect(await outcomes(t.id)).toEqual(["error"]);
});
