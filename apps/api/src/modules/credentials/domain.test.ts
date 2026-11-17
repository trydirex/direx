// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { needsRefresh, REFRESH_WINDOW_MS } from "./domain/refresh";
import { readiness, type ReadinessRow } from "./domain/status";
import { KINDS, parseKind } from "./application/kinds";

const live: ReadinessRow = { scope: "user", status: "active", deletedAt: null };

test("readiness names why a credential cannot be used, in order", () => {
  expect(readiness(null, true)).toBe("missing");
  expect(readiness({ ...live, deletedAt: new Date(), status: "revoked" }, true)).toBe("deleted");
  expect(readiness({ ...live, status: "revoked" }, true)).toBe("revoked");
  expect(readiness({ ...live, status: "needs_reauth" }, true)).toBe("needs_reauth");
  expect(readiness(live, true)).toBeNull();
});

test("a user credential is not ready once its owner left; a workspace one has no owner", () => {
  expect(readiness(live, false)).toBe("owner_left");
  expect(readiness({ ...live, scope: "workspace" }, false)).toBeNull();
});

test("a token is refreshed when less than the window is left", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  const at = (ms: number) => new Date(now.getTime() + ms);
  expect(needsRefresh(at(REFRESH_WINDOW_MS + 1), now)).toBe(false);
  expect(needsRefresh(at(REFRESH_WINDOW_MS), now)).toBe(false);
  expect(needsRefresh(at(REFRESH_WINDOW_MS - 1), now)).toBe(true);
  expect(needsRefresh(at(-1), now)).toBe(true);
});

const good = {
  oauth2: {
    value: { refreshToken: "r", accessToken: "a", expiresAt: "2026-10-29T13:00:00.000Z" },
    meta: { accountEmail: "x@example.com", scopes: ["openid"] },
  },
  api_key: { value: { key: "sk-1" }, meta: {} },
  header: { value: { value: "Bearer abc" }, meta: { headerName: "Authorization" } },
  basic: { value: { password: "pw" }, meta: { username: "x@example.com" } },
  secret: { value: { value: "whsec" }, meta: {} },
} as const;

test("every kind accepts its own value and meta", () => {
  expect(Object.keys(good).sort()).toEqual([...KINDS].sort());
  for (const kind of KINDS) {
    const r = parseKind(kind, good[kind].value, good[kind].meta);
    expect(r, kind).toMatchObject({ ok: true, kind, value: good[kind].value, meta: good[kind].meta });
  }
});

test("an API key's meta holds only the chosen list", () => {
  expect(parseKind("api_key", { key: "sk-1" }, { listId: "a1b2c3", listName: "Weekly" })).toMatchObject({ ok: true, meta: { listId: "a1b2c3", listName: "Weekly" } });
  expect(parseKind("api_key", { key: "sk-1" }, { listId: "" })).toMatchObject({ ok: false, reason: "bad_meta" });
  expect(parseKind("api_key", { key: "sk-1" }, { audience: "a1b2c3" })).toMatchObject({ ok: false, reason: "bad_meta" });
});

test("a secret-looking field in meta is refused, never stored in the clear", () => {
  for (const field of ["token", "secret", "password", "key", "authorization", "refreshToken"]) {
    const r = parseKind("api_key", { key: "sk-1" }, { [field]: "leak" });
    expect(r).toMatchObject({ ok: false, reason: "bad_meta" });
    if (!r.ok) expect(r.detail).toContain(field);
  }
});

test("a bad value is refused, and the refusal never repeats the value", () => {
  const leak = "sk-should-not-appear";
  const cases: [Parameters<typeof parseKind>[0], unknown, unknown][] = [
    ["api_key", { key: "" }, {}],
    ["api_key", { key: leak, extra: leak }, {}],
    ["oauth2", { refreshToken: leak, accessToken: leak, expiresAt: leak }, good.oauth2.meta],
    ["basic", { password: 42 }, { username: "u" }],
    ["header", { value: leak }, { headerName: "Bad Header" }],
  ];
  for (const [kind, value, meta] of cases) {
    const r = parseKind(kind, value, meta);
    expect(r.ok, kind).toBe(false);
    if (!r.ok) expect(r.detail).not.toContain(leak);
  }
  expect(parseKind("nope" as "secret", {}, {})).toMatchObject({ ok: false, reason: "unknown_kind" });
});
