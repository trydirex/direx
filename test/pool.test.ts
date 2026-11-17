// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "vitest";
import pg from "pg";
import { expectPgBouncer, hasPool, poolUrl } from "./db";

describe.skipIf(!hasPool)("PgBouncer", () => {
  test("this file's cloned database is reachable through PgBouncer, and SET LOCAL holds for one transaction", async () => {
    const url = poolUrl();
    await expectPgBouncer(url);
    const c = new pg.Client(url);
    await c.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.workspace_id', '00000000-0000-0000-0000-000000000001', true)");
      const { rows } = await c.query("select current_database() db, current_user u, current_setting('app.workspace_id') w");
      await c.query("commit");
      expect(rows[0]).toEqual({
        db: new URL(url).pathname.slice(1),
        u: "direx_app",
        w: "00000000-0000-0000-0000-000000000001",
      });
    } finally {
      await c.end();
    }
  });

  test("the PgBouncer check refuses a plain Postgres port", async () => {
    await expect(expectPgBouncer(process.env.DIREX_DB_APP_URL!)).rejects.toThrow();
  });
});
