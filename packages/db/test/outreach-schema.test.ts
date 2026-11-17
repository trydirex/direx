// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of the eligibility record and the sender's country, as direx_app.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { appClient, insertAuthUser, ownerClient } from "../../../test/db";

let c: pg.Client;
const W = crypto.randomUUID();
const U = crypto.randomUUID();

const insertRecord = async (cols: Record<string, string>) => {
  const person = crypto.randomUUID();
  await c.query("insert into people (id, workspace_id, coordination_id, created_at) values ($1, $2, $1, now())", [person, W]);
  const names = Object.keys(cols);
  const { rows } = await c.query(
    `insert into person_eligibility (workspace_id, person_id, country, basis, evidence, recorded_by, recorded_at${names.map((n) => `, ${n}`).join("")})
     values ($1, $2, 'GB', 'published_address', 'site', $3, now()${names.map((_, i) => `, $${i + 4}`).join("")})
     returning entity_type, country_confidence, expires_at`,
    [W, person, U, ...Object.values(cols)],
  );
  return rows[0];
};

beforeAll(async () => {
  c = await appClient();
  await insertAuthUser(U);
  const orgId = crypto.randomUUID();
  const at = new Date();
  await withWorkspace(W, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: at });
    await tx.insert(workspaces).values({ id: W, orgId, name: "W", createdAt: at });
  });
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
afterAll(() => c.end());

test("a record with none of the new fields reads as an unknown entity with a stated country and no expiry", async () => {
  expect(await insertRecord({})).toEqual({ entity_type: "unknown", country_confidence: "stated", expires_at: null });
});

test("the new fields take only their known values", async () => {
  await expect(insertRecord({ entity_type: "sole_trader", country_confidence: "inferred", scope: "Product updates" })).resolves.toMatchObject({ entity_type: "sole_trader" });
  await expect(insertRecord({ entity_type: "sole" })).rejects.toThrow(/person_eligibility_entity_type_check/);
  await expect(insertRecord({ country_confidence: "guessed" })).rejects.toThrow(/person_eligibility_country_confidence_check/);
  await expect(insertRecord({ scope: "x".repeat(501) })).rejects.toThrow(/person_eligibility_scope_check/);
});

test("the sender's country is a two-letter code or empty", async () => {
  await c.query("insert into outreach_settings (workspace_id, updated_at) values ($1, now())", [W]);
  await expect(c.query("update outreach_settings set sender_country = 'CA'")).resolves.toBeDefined();
  await expect(c.query("update outreach_settings set sender_country = 'Canada'")).rejects.toThrow(/outreach_settings_sender_country_check/);
});

describe("outside_touches", () => {
  const newPerson = async () => {
    const person = crypto.randomUUID();
    await c.query("insert into people (id, workspace_id, coordination_id, created_at) values ($1, $2, $1, now())", [person, W]);
    return person;
  };
  const insertTouch = async (person: string, cols: Record<string, string | null> = {}) => {
    const row = { channel: "call", direction: "outbound", source: "manual", source_ref: null, ...cols };
    const names = Object.keys(row);
    const { rows } = await c.query(
      `insert into outside_touches (workspace_id, person_id, occurred_at, created_by, created_at, ${names.join(", ")})
       values ($1, $2, now(), $3, now(), ${names.map((_, i) => `$${i + 4}`).join(", ")}) returning id`,
      [W, person, U, ...Object.values(row)],
    );
    return rows[0].id as string;
  };

  test("a manual entry has no source ref and a drafted DM has one, used once", async () => {
    const p = await newPerson();
    await insertTouch(p);
    await expect(insertTouch(p, { source_ref: "ref" })).rejects.toThrow(/outside_touches_source_ref_check/);
    await expect(insertTouch(p, { source: "direx_draft" })).rejects.toThrow(/outside_touches_source_ref_check/);
    const ref = crypto.randomUUID();
    await insertTouch(p, { source: "direx_draft", source_ref: ref });
    await expect(insertTouch(p, { source: "direx_draft", source_ref: ref })).rejects.toThrow(/outside_touches_source_ref_key/);
    await expect(insertTouch(p, { channel: "fax" })).rejects.toThrow(/outside_touches_channel_check/);
  });

  test("rows are never updated, and only a manual entry under 10 minutes old can be deleted", async () => {
    const p = await newPerson();
    const manual = await insertTouch(p);
    await expect(c.query("update outside_touches set channel = 'x' where id = $1", [manual])).rejects.toThrow(/permission denied/);
    const drafted = await insertTouch(p, { source: "direx_draft", source_ref: crypto.randomUUID() });
    expect((await c.query("delete from outside_touches where id = $1", [drafted])).rowCount).toBe(0);
    const old = await insertTouch(p);
    const owner = await ownerClient();
    try {
      await owner.query("update outside_touches set created_at = now() - interval '11 minutes' where id = $1", [old]);
    } finally {
      await owner.end();
    }
    expect((await c.query("delete from outside_touches where id = $1", [old])).rowCount).toBe(0);
    expect((await c.query("delete from outside_touches where id = $1", [manual])).rowCount).toBe(1);
  });

  test("another Workspace can't read them", async () => {
    await insertTouch(await newPerson());
    await c.query("select set_config('app.workspace_id', $1, false)", [crypto.randomUUID()]);
    try {
      expect((await c.query("select count(*)::int as n from outside_touches")).rows[0].n).toBe(0);
    } finally {
      await c.query("select set_config('app.workspace_id', $1, false)", [W]);
    }
  });
});

describe("undoing a reply opt-out", () => {
  const W2 = crypto.randomUUID();
  const undo = (emails: string[], why = "Asked for pricing, not to stop", quote: string | null = "stop the pricing emails, send the deck") =>
    c.query("select system.undo_reply_suppressions($1, $2, $3, $4) as n", [emails, U, why, quote]).then((r) => r.rows[0].n as number);
  const suppress = (email: string, reason: string) =>
    c.query("insert into suppressions (workspace_id, email, reason, created_at) values (current_setting('app.workspace_id')::uuid, $1, $2, now())", [email, reason]);
  const suppressed = async (email: string) =>
    (await c.query("select reason from suppressions where email = $1", [email])).rows.map((r) => r.reason as string);

  beforeAll(async () => {
    const orgId = crypto.randomUUID();
    await withWorkspace(W2, async (tx) => {
      await tx.insert(organizations).values({ id: orgId, name: "Org 2", createdAt: new Date() });
      await tx.insert(workspaces).values({ id: W2, orgId, name: "W2", createdAt: new Date() });
    });
  });

  test("only reply rows are moved, and the record keeps who, when, why and the quote", async () => {
    const [r, b, u, m] = ["reply", "bounce", "unsub", "manual"].map((k) => `${k}-${crypto.randomUUID()}@example.com`);
    await suppress(r!, "reply");
    await suppress(b!, "hard_bounce");
    await suppress(u!, "unsubscribe");
    await suppress(m!, "manual");
    expect(await undo([r!, b!, u!, m!])).toBe(1);
    expect(await suppressed(r!)).toEqual([]);
    expect([await suppressed(b!), await suppressed(u!), await suppressed(m!)]).toEqual([["hard_bounce"], ["unsubscribe"], ["manual"]]);
    const { rows } = await c.query("select undone_by, reason, quote, suppressed_at is not null as had, undone_at is not null as at from suppression_reversals where email = $1", [r]);
    expect(rows).toEqual([{ undone_by: U, reason: "Asked for pricing, not to stop", quote: "stop the pricing emails, send the deck", had: true, at: true }]);
  });

  test("an address with nothing to undo returns 0 and records nothing", async () => {
    const e = `none-${crypto.randomUUID()}@example.com`;
    expect(await undo([e])).toBe(0);
    expect((await c.query("select count(*)::int as n from suppression_reversals where email = $1", [e])).rows[0].n).toBe(0);
  });

  test("a blank reason is refused and the opt-out stays", async () => {
    const e = `blank-${crypto.randomUUID()}@example.com`;
    await suppress(e, "reply");
    await expect(undo([e], "   ")).rejects.toThrow(/suppression_reversals_reason_check/);
    expect(await suppressed(e)).toEqual(["reply"]);
  });

  test("another Workspace's opt-out for the same address stays", async () => {
    const e = `shared-${crypto.randomUUID()}@example.com`;
    await c.query("select set_config('app.workspace_id', $1, false)", [W2]);
    try {
      await suppress(e, "reply");
    } finally {
      await c.query("select set_config('app.workspace_id', $1, false)", [W]);
    }
    await suppress(e, "reply");
    expect(await undo([e])).toBe(1);
    await c.query("select set_config('app.workspace_id', $1, false)", [W2]);
    try {
      expect(await suppressed(e)).toEqual(["reply"]);
    } finally {
      await c.query("select set_config('app.workspace_id', $1, false)", [W]);
    }
  });

  test("the app can't delete a suppression or write the record itself", async () => {
    const e = `direct-${crypto.randomUUID()}@example.com`;
    await suppress(e, "reply");
    await expect(c.query("delete from suppressions where email = $1", [e])).rejects.toThrow(/permission denied/);
    await expect(
      c.query("insert into suppression_reversals (workspace_id, email, suppressed_at, undone_by, reason, undone_at) values ($1, $2, now(), $3, 'x', now())", [W, e, U]),
    ).rejects.toThrow(/permission denied/);
    await undo([e]);
    await expect(c.query("update suppression_reversals set reason = 'y' where email = $1", [e])).rejects.toThrow(/permission denied/);
    await expect(c.query("delete from suppression_reversals where email = $1", [e])).rejects.toThrow(/permission denied/);
  });
});
