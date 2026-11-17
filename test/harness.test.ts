// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { appClient } from "./db";

test("each test file gets its own cloned database, as direx_app", async () => {
  const c = await appClient();
  const { rows } = await c.query("select current_database() db, current_user u");
  await c.end();
  expect(rows[0].db).toMatch(/^direx_t_[0-9a-f]{32}$/);
  expect(rows[0].u).toBe("direx_app");
});
