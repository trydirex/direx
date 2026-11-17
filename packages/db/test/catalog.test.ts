// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { appClient, ownerClient } from "../../../test/db";
import { COLUMN_WINDOWS, RETENTION } from "../src/retention";
import { catalogViolations } from "./catalog";

test("the migrated database passes every catalog check, read as direx_app", async () => {
  const c = await appClient();
  try {
    // The API role is not the owner, and catalogViolations proves it owns no table.
    expect((await c.query("select current_user")).rows[0].current_user).toBe("direx_app");
    expect(await catalogViolations(c)).toEqual([]);
    // ADR 0030 Q3: only the owner-side purge deletes the ledger and the eligibility records, never the app.
    for (const t of ["actions", "approvals", "action_events", "person_eligibility"])
      expect((await c.query("select has_table_privilege(current_user, $1, 'DELETE') as d", [`public.${t}`])).rows[0].d, t).toBe(false);
  } finally {
    await c.end();
  }
});

test.each([
  ["no-force.sql", /^forced-rls: .*fx_no_force .*FORCE ROW LEVEL SECURITY is off/],
  ["rls-off.sql", /^forced-rls: .*fx_rls_off .*ROW LEVEL SECURITY is off/],
  ["single-column-fk.sql", /^workspace-fk: .*fx_child to fx_parent/],
  ["app-owns-table.sql", /^app-owns-table: table fx_app_owned is owned by direx_app/],
  ["system-table-grant.sql", /^system-role: .*fx_granted/],
  ["system-invoker-function.sql", /^system-role: function system\.fx_invoker\(\) /],
  ["unlisted-table.sql", /^retention: table public\.fx_unlisted has no entry/],
  ["app-delete.sql", /^app-delete: direx_app holds DELETE on table public\.actions/],
  ["app-deleted-at.sql", /^app-update: direx_app can UPDATE workspaces\.deleted_at/],
  ["app-insert-deleted.sql", /^app-insert: direx_app can INSERT a workspaces row with deleted_at set/],
  ["app-purge.sql", /^app-purge: direx_app can EXECUTE system\.purge_workspace_batch\(uuid,text,integer\)/],
])("fixture %s fails the catalog check with its rule name", async (fixture, expected) => {
  const c = await ownerClient();
  try {
    await c.query("begin");
    await c.query(readFileSync(`${import.meta.dirname}/fixtures/${fixture}`, "utf8"));
    expect(await catalogViolations(c)).toContainEqual(expect.stringMatching(expected));
  } finally {
    await c.query("rollback");
    await c.end();
  }
});

test("the retention list fails on an entry with no table, a class that does not fit, and a column that is gone", async () => {
  const c = await appClient();
  try {
    const retention = {
      ...RETENTION,
      "public.fx_gone": { class: "audit" },
      "public.actions": { class: "account" },
      "public.organizations": { class: "audit", appDeletes: true },
      "public.trigger_events": { ...RETENTION["public.trigger_events"]!, window: "received_at < now() - interval '1 day'" },
      "public.model_calls": { ...RETENTION["public.model_calls"]!, sweep: "system.fx_no_sweep" },
    } as const;
    const columns = [...COLUMN_WINDOWS, { table: "public.media", column: "fx_gone", window: "true", by: "nothing" }];
    const found = await catalogViolations(c, retention, columns);
    expect(found).toContain("retention: entry public.fx_gone names no table");
    expect(found).toContain("retention: tenant table public.actions is listed as account, not audit, operational or suppression");
    expect(found).toContain("retention: table public.organizations has no workspace_id but is listed as audit");
    expect(found).toContain("retention: column window public.media.fx_gone names no column");
    expect(found).toContain("retention: system.sweep_trigger_events does not delete from public.trigger_events by its window");
    expect(found).toContain("retention: public.model_calls names system.fx_no_sweep, which is not a function of one integer");
  } finally {
    await c.end();
  }
});
