// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of the people and reservation tables, as direx_app.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { appClient } from "../../../test/db";

const W = crypto.randomUUID();
const V = crypto.randomUUID();
let c: pg.Client;

const as = (w: string) => c.query("select set_config('app.workspace_id', $1, false)", [w]);
const person = async (w: string) => {
  const id = crypto.randomUUID();
  await c.query("insert into people (id, workspace_id, coordination_id, created_at) values ($1, $2, $1, now())", [id, w]);
  return id;
};
const action = async (w: string) => {
  const { rows } = await c.query(
    `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, spec, spec_hash, created_at, updated_at)
     values ($1, gen_random_uuid(), 'test.send', 'blind', 'draft', '{}', 'h', now(), now()) returning id`,
    [w],
  );
  return rows[0].id as string;
};
const reserve = (w: string, actionId: string, personId: string) =>
  c.query(
    `insert into touch_reservations (workspace_id, action_id, person_id, touch_class, cap, slot, created_at)
     values ($1, $2, $3, 'cold', 'general', now(), now())`,
    [w, actionId, personId],
  );

beforeAll(async () => {
  c = await appClient();
});
afterAll(() => c.end());

test("a reservation can't point at another workspace's Action or Person", async () => {
  await as(V);
  const otherAction = await action(V);
  const otherPerson = await person(V);
  await as(W);
  const p = await person(W);
  const a = await action(W);
  await expect(reserve(W, otherAction, p)).rejects.toThrow(/touch_reservations_action_fk/);
  await expect(reserve(W, a, otherPerson)).rejects.toThrow(/touch_reservations_person_fk/);
  await expect(reserve(W, a, p)).resolves.toBeDefined();
});

test("a record's group must be a record in the same workspace", async () => {
  await as(V);
  const other = await person(V);
  await as(W);
  await expect(
    c.query("insert into people (id, workspace_id, coordination_id, created_at) values (gen_random_uuid(), $1, $2, now())", [W, other]),
  ).rejects.toThrow(/people_coordination_fk/);
});

test("reservations never change, and records and links are never deleted", async () => {
  await as(W);
  await expect(c.query("update touch_reservations set slot = now()")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from touch_reservations")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from people")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from person_links")).rejects.toThrow(/permission denied/);
});

test("a link joins a lower id to a higher one, and only a decided link has a decision time", async () => {
  await as(W);
  const [lo, hi] = [await person(W), await person(W)].sort();
  const link = (low: string, high: string, state: string, decided: string) =>
    c.query(
      `insert into person_links (workspace_id, low_id, high_id, state, decided_at, created_at) values ($1, $2, $3, $4, ${decided}, now())`,
      [W, low, high, state],
    );
  await expect(link(hi!, lo!, "proposed", "null")).rejects.toThrow(/person_links_order_check/);
  await expect(link(lo!, hi!, "merged", "null")).rejects.toThrow(/person_links_decided_check/);
  await expect(link(lo!, hi!, "proposed", "null")).resolves.toBeDefined();
});
