// SPDX-License-Identifier: AGPL-3.0-only
// The status write-back jobs through a pg-boss that records what it is given: which Workspaces the sweep
// writes back for, when it does nothing, and which one-source jobs reach a source.
import { expect, test } from "vitest";
import { recordedBoss } from "./fixtures/boss";
import { DOCS_WRITE_BACK, DOCS_WRITE_BACK_ONE, writeBackJobs } from "./write-back";

const W1 = "00000000-0000-4000-8000-000000000001";
const W2 = "00000000-0000-4000-8000-000000000002";
const SOURCE = "00000000-0000-4000-8000-0000000000aa";

function setup(provider: Parameters<typeof writeBackJobs>[0]["provider"]) {
  const r = recordedBoss();
  const calls: string[] = [];
  writeBackJobs({
    boss: r.boss,
    later: r.later,
    provider,
    connected: async () => [{ workspaceId: W1 }, { workspaceId: W1 }, { workspaceId: W2 }],
    writeBack: { workspace: async (w) => void calls.push(`workspace ${w}`), source: async (w, s) => void calls.push(`source ${w} ${s}`) },
  });
  return { r, calls };
}

test("the sweep writes back once per Workspace with a docs connection", async () => {
  const { r, calls } = setup({ connections: ["notion"], write: "notion/docs.write" });
  await r.start();
  expect(Object.fromEntries(r.crons)).toEqual({ [DOCS_WRITE_BACK]: "*/5 * * * *" });
  await r.run(DOCS_WRITE_BACK);
  expect(calls).toEqual([`workspace ${W1}`, `workspace ${W2}`]);
});

test("with no docs plugin, or one that can't write, the sweep does nothing", async () => {
  for (const provider of [undefined, { connections: ["notion"] }]) {
    const { r, calls } = setup(provider);
    await r.start();
    await r.run(DOCS_WRITE_BACK);
    expect(calls).toEqual([]);
  }
});

test("a one-source job writes that source; a malformed job is ignored", async () => {
  const { r, calls } = setup({ connections: ["notion"], write: "notion/docs.write" });
  await r.start();
  await r.run(DOCS_WRITE_BACK_ONE, { workspaceId: W1, sourceId: SOURCE });
  await r.run(DOCS_WRITE_BACK_ONE, { workspaceId: "not-a-uuid", sourceId: SOURCE });
  await r.run(DOCS_WRITE_BACK_ONE);
  expect(calls).toEqual([`source ${W1} ${SOURCE}`]);
});
