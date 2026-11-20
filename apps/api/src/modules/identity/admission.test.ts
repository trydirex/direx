// SPDX-License-Identifier: AGPL-3.0-only
// The self-host Admission over migration 0126 (ADR 0024): its order, domains, tokens, and the
// cloud refusal (DX-R-0024-003, -011).
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { insertAuthUser, ownerClient } from "../../../../../test/db";
import { asciiEmail, pickAdmission, selfHostAdmission } from "./application/admission";
import type { Admission } from "./domain/admission";

let owner: Awaited<ReturnType<typeof ownerClient>>;
const prod = selfHostAdmission({ devMode: false });
const dev = selfHostAdmission({ devMode: true });
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

const setPolicy = (policy: string, domains: string[] = []) =>
  owner.query("update system.server_settings set signup_policy = $1, allowed_domains = $2", [policy, domains]);

beforeAll(async () => {
  owner = await ownerClient();
});
afterAll(() => owner.end());
beforeEach(async () => {
  await owner.query("delete from system.server_admins; delete from system.bootstrap_invites; delete from system.server_admin_events;");
  await setPolicy("invite_only");
});

test("asciiEmail lowercases, trims and turns an international domain into punycode", () => {
  expect(asciiEmail("  Sam@BÜCHER.de ")).toBe("sam@xn--bcher-kva.de");
  expect(asciiEmail("Kim@Acme.COM")).toBe("kim@acme.com");
  expect(asciiEmail("no-at-sign")).toBe("no-at-sign");
});

test("dev and test admit everyone, verified or not, and anyone may create an Organization", async () => {
  expect(await dev.admit({ email: "x@example.com", emailVerified: false })).toEqual({ ok: true, via: "open" });
  expect(await dev.canCreateOrganization(crypto.randomUUID())).toBe(true);
});

test("a server with no accounts leads to sign-up in dev and to the bootstrap link outside it; any account ends that", async () => {
  const none = async () => false;
  expect(await selfHostAdmission({ devMode: true, hasAccounts: none }).firstRun?.()).toBe("sign_up");
  expect(await selfHostAdmission({ devMode: false, hasAccounts: none }).firstRun?.()).toBe("needs_link");
  // The shared test database always has accounts, and the server is unclaimed here (beforeEach):
  // an upgraded server with users and no Server admin still shows sign-in.
  await insertAuthUser(crypto.randomUUID());
  expect(await prod.firstRun?.()).toBeNull();
  expect(await dev.firstRun?.()).toBeNull();
});

test("outside dev an unverified email is refused before any policy", async () => {
  await setPolicy("anyone");
  expect(await prod.admit({ email: "x@example.com", emailVerified: false })).toEqual({ ok: false, reason: "unverified" });
});

test("Invite only is the default, and its refusal says so", async () => {
  expect(await prod.admit({ email: "x@example.com", emailVerified: true })).toEqual({ ok: false, reason: "closed", policy: "invite_only", domains: [] });
  expect(await prod.status()).toEqual({ claimed: false, policy: "invite_only", domains: [] });
});

test("allowed domains match exactly, in punycode, and a refusal names them", async () => {
  await setPolicy("domains", ["acme.com", "xn--bcher-kva.de"]);
  expect(await prod.admit({ email: "Sam@Bücher.de", emailVerified: true })).toEqual({ ok: true, via: "policy" });
  expect(await prod.admit({ email: "kim@ACME.com", emailVerified: true })).toEqual({ ok: true, via: "policy" });
  expect(await prod.admit({ email: "kim@mail.acme.com", emailVerified: true })).toEqual({
    ok: false,
    reason: "closed",
    policy: "domains",
    domains: ["acme.com", "xn--bcher-kva.de"],
  });
});

test("Anyone admits every verified email", async () => {
  await setPolicy("anyone");
  expect(await prod.admit({ email: "x@example.com", emailVerified: true })).toEqual({ ok: true, via: "policy" });
});

test("a bootstrap token admits under Invite only, by its raw value", async () => {
  const token = randomBytes(32).toString("hex");
  await owner.query("select system.issue_bootstrap_invite($1, now() + interval '1 hour')", [sha(token)]);
  expect(await prod.admit({ email: "first@anywhere.io", emailVerified: true, token })).toEqual({ ok: true, via: "bootstrap" });
  expect((await prod.admit({ email: "first@anywhere.io", emailVerified: true, token: "wrong" })).ok).toBe(false);
});

test("outside dev only a Server admin may create an Organization", async () => {
  const [admin, other] = [crypto.randomUUID(), crypto.randomUUID()];
  await insertAuthUser(admin);
  await insertAuthUser(other);
  await owner.query("insert into system.server_admins (user_id) values ($1)", [admin]);
  expect(await prod.canCreateOrganization(admin)).toBe(true);
  expect(await prod.canCreateOrganization(other)).toBe(false);
  expect((await prod.status()).claimed).toBe(true);
});

test("cloud must supply its own Admission; self-host gets the core one (DX-R-0024-011)", () => {
  expect(() => pickAdmission("cloud", undefined, false)).toThrow(/Cloud must supply its own Admission/);
  const supplied: Admission = { admit: async () => ({ ok: true, via: "open" }), canCreateOrganization: async () => false, status: prod.status };
  expect(pickAdmission("cloud", supplied, false)).toBe(supplied);
  expect(pickAdmission("self_host", supplied, false)).toBe(supplied);
  expect(pickAdmission("self_host", undefined, false)).not.toBe(supplied);
});
