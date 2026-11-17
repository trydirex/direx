// SPDX-License-Identifier: AGPL-3.0-only
// The programs as a package that adds extensions starts them: with no discovery the server gets the
// default that refuses, and a supplied one reaches prospecting through its worker. The worker alone
// refuses to start (ADR 0027).
import { expect, test } from "vitest";
import type { Discovery } from "./modules/extensions/index";
import { app, createApp, runServer, runWorker, startServer } from "./main";
import { compose, type WorkerOptions } from "./worker";

process.env.DIREX_MASTER_KEY = "11".repeat(32);
const found = { domain: "acme.test", name: "Acme", source: "fake" };
const discovery: Discovery = { estimate: async () => ({ usd: 0.5 }), search: async () => [found] };

test("the server starts with the default discovery, or with one it is given", { timeout: 30_000 }, async () => {
  const plain = await runServer();
  try {
    // The app runServer serves is built by the same createApp as the one importers read.
    const routes = (a: typeof app) => a.routes.map((r) => `${r.method} ${r.path}`);
    expect(routes(plain.app)).toEqual(routes(app));
    await expect(plain.discovery.search("w", ["dentists"], 10)).rejects.toMatchObject({ reason: "not_available" });
  } finally {
    await plain.stop();
  }
  const extended = await runServer({ discovery });
  try {
    expect(extended.discovery).toBe(discovery);
    expect(await extended.discovery.search("w", ["dentists"], 10)).toEqual([found]);
  } finally {
    await extended.stop();
  }
});

test("bun run worker on self-host refuses to start and says a self-hosted Direx runs as one process", async () => {
  try {
    await expect(runWorker()).rejects.toThrow(/DIREX_ROLE=worker is for Direx cloud only.*unset DIREX_ROLE/);
  } finally {
    delete process.env.DIREX_ROLE;
  }
});

test("the worker refuses to compose without a feature port, and names the one missing (rule 003)", async () => {
  const { ports } = createApp({ worker: () => undefined });
  // @ts-expect-error outreach is a required port
  await expect(compose({ ...ports, outreach: undefined })).rejects.toThrow("the worker needs the outreach port");
  await expect(compose({} as WorkerOptions)).rejects.toThrow(/the worker needs the \w+ port/);
});

test("startServer serves HTTP and installs the stop on both signals", { timeout: 30_000 }, async () => {
  const before = { SIGTERM: process.listeners("SIGTERM"), SIGINT: process.listeners("SIGINT") };
  const port = process.env.PORT;
  process.env.PORT = "0";
  const { server, worker } = await startServer({ discovery });
  try {
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
    for (const s of ["SIGTERM", "SIGINT"] as const) expect(process.listeners(s).length).toBe(before[s].length + 1);
  } finally {
    // The test runner keeps its own handlers; only the stop installed here is removed.
    for (const s of ["SIGTERM", "SIGINT"] as const) for (const h of process.listeners(s)) if (!before[s].includes(h)) process.off(s, h);
    if (port === undefined) delete process.env.PORT;
    else process.env.PORT = port;
    await server.stop(true);
    await worker.stop();
  }
});
