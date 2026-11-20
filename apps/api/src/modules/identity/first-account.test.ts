// SPDX-License-Identifier: AGPL-3.0-only
// The first account on an empty server skips the email confirmation when it comes with the
// bootstrap link (ADR 0024 rule 002, amended 2026-11-20). Its own file, so it starts with no accounts.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { selfHostAdmission } from "./application/admission";
import { testIdentity } from "./test-auth";

const closed = testIdentity({ devMode: false, admission: selfHostAdmission({ devMode: false }) });
let owner: Awaited<ReturnType<typeof ownerClient>>;

const post = (path: string, body: unknown, token?: string) =>
  closed.routes.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token && { cookie: `direx_invite=${token}` }) },
    body: JSON.stringify(body),
  });
const signUp = (email: string, token: string) => post("/sign-up/email", { email, password: "correct horse battery", name: email }, token);
const signIn = (email: string) => post("/sign-in/email", { email, password: "correct horse battery" });
const mailTo = (email: string) => closed.outbox.filter((m) => m.to === email);
const verified = async (res: Response) => ((await res.json()) as { user: { emailVerified: boolean } }).user.emailVerified;

beforeAll(async () => {
  owner = await ownerClient();
});
afterAll(() => owner.end());

test("the first account signs up verified with no mail; a second one made with the same link still confirms", async () => {
  expect((await owner.query('select count(*)::int as n from auth."user"')).rows[0].n).toBe(0);
  const token = randomBytes(32).toString("hex");
  await owner.query("select system.issue_bootstrap_invite($1, now() + interval '1 hour')", [createHash("sha256").update(token).digest("hex")]);

  const first = await signUp("first@example.com", token);
  expect(first.status).toBe(200);
  expect(await verified(first)).toBe(true);
  expect((await signIn("first@example.com")).status).toBe(200);
  expect(mailTo("first@example.com")).toEqual([]);

  // The link lasts until someone claims, so it mustn't vouch for addresses nobody proved.
  const second = await signUp("second@example.com", token);
  expect(second.status).toBe(200);
  expect(await verified(second)).toBe(false);
  expect((await signIn("second@example.com")).status).toBe(403);
  expect(mailTo("second@example.com").some((m) => m.subject === "Confirm your email for Direx")).toBe(true);
});
