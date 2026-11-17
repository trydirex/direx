// SPDX-License-Identifier: AGPL-3.0-only
// Address checks as the worker wires them: the loaded plugin that verifies addresses, through the
// Workspace's active credential on that plugin's connection. The plugin query is a fake.
import { VERIFY_ADDRESS } from "@direx/plugin-sdk";
import { expect, test } from "vitest";
import type { Vault } from "./modules/credentials/index";
import { verifyForWorkspace } from "./worker";

const answer = { result: "deliverable", vendorStatus: "safe", credits: 1, costMicros: 0 };
type Listed = Awaited<ReturnType<Vault["list"]>>;

test("checks go to the verifying plugin with the Workspace's active credential on its connection", async () => {
  const calls: unknown[][] = [];
  const query = async (...args: unknown[]) => {
    calls.push(args);
    return answer;
  };
  let listed = [
    { id: "mail", connection: "gmail", status: "active" },
    { id: "old", connection: "reoon", status: "revoked" },
    { id: "key", connection: "reoon", status: "active" },
  ];
  const vault = { list: async () => listed as unknown as Listed };
  const verify = verifyForWorkspace({ query }, vault);
  expect(await verify("w", "ana@acme.test")).toEqual(answer);
  expect(calls).toEqual([["w", expect.stringMatching(new RegExp(`/${VERIFY_ADDRESS.replace(".", "\\.")}$`)), { email: "ana@acme.test" }, "key"]]);

  listed = listed.filter((c) => c.id !== "key");
  expect(await verify("w", "ana@acme.test")).toBeNull();
  expect(await verifyForWorkspace({ query }, vault, [])("w", "ana@acme.test")).toBeNull();
});
