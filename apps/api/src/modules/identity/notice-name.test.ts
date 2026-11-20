// SPDX-License-Identifier: AGPL-3.0-only
// Notices name their Workspace, so an Admin of several Workspaces on one server can tell which one a
// notice is about (TASKS #35, spec Part A).
import { createTransport } from "nodemailer";
import { expect, test } from "vitest";
import { seedMember } from "./fixtures/member";
import { named, workspaceName } from "./index";

const mail = { subject: "Direx model cost reached 80% of this month's budget", text: "Model cost has reached 80% of the monthly budget." };

test("a named notice starts its subject and its text with the Workspace", () => {
  expect(named("Acme Dental")(mail)).toEqual({
    subject: "Acme Dental: Direx model cost reached 80% of this month's budget",
    text: "Workspace: Acme Dental\n\nModel cost has reached 80% of the monthly budget.",
  });
});

test("without a name the notice goes out unchanged", () => {
  expect(named(null)(mail)).toEqual(mail);
});

test("workspaceName reads the Workspace's own name, and null for one that doesn't exist", async () => {
  const w = crypto.randomUUID();
  await seedMember(w, crypto.randomUUID());
  expect(await workspaceName(w)).toBe("Test");
  expect(await workspaceName(crypto.randomUUID())).toBeNull();
});

test("a name holding a line break can't add a header to the notice", async () => {
  const transport = createTransport({ streamTransport: true, buffer: true });
  const sent = await transport.sendMail({ from: "signin@example.com", to: "admin@example.com", ...named("Acme\r\nBcc: someone@example.com")(mail) });
  const raw = (sent.message as Buffer).toString();
  const headers = raw.slice(0, raw.indexOf("\r\n\r\n"));
  expect(headers).not.toMatch(/^Bcc:/im);
  expect(headers.match(/^Subject:/gim)).toHaveLength(1);
});
