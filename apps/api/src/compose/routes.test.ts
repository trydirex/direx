// SPDX-License-Identifier: AGPL-3.0-only
// Every route and middleware the app mounts, in order, against a list recorded before main.ts's routes
// moved into createApp (ADR 0027 rule 001). Order matters: it decides which middleware runs first. A
// route wired to a different place, dropped or added fails here. DIREX_RECORD_ROUTES=1 rewrites the
// list; review that diff like code.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { app } from "../main";

const FIXTURE = join(import.meta.dirname, "fixtures", "routes.json");

test("the app mounts the same routes and middleware, in the same order, as before the refactor", () => {
  const routes = app.routes.map((r) => `${r.method} ${r.path}`);
  if (process.env.DIREX_RECORD_ROUTES === "1") writeFileSync(FIXTURE, `${JSON.stringify(routes, null, 2)}\n`);
  expect(routes).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  expect(new Set(routes).size).toBeGreaterThan(300);
});
