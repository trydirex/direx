// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { withWorkspace } from "../src/index";
import { noteComments, notes } from "../src/schema";
import { appClient } from "../../../test/db";

const A = crypto.randomUUID();
const B = crypto.randomUUID();
const now = new Date();

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code ?? err.cause?.code;
}

async function addNote(workspaceId: string, body: string) {
  const [row] = await withWorkspace(workspaceId, (tx) =>
    tx.insert(notes).values({ workspaceId, body, createdAt: now }).returning(),
  );
  return row!;
}

test("outside withWorkspace, direx_app reads no tenant rows and cannot insert", async () => {
  await addNote(A, "a1");
  const c = await appClient();
  try {
    expect((await c.query("select * from notes")).rowCount).toBe(0);
    const insert = c.query("insert into notes (workspace_id, body, created_at) values ($1, 'x', now())", [A]);
    await expect(insert).rejects.toMatchObject({ code: "42501" });
  } finally {
    await c.end();
  }
});

test("SET LOCAL ends with the transaction, so a reused connection sees nothing", async () => {
  await addNote(A, "a2");
  const c = await appClient();
  try {
    await c.query("begin");
    await c.query("select set_config('app.workspace_id', $1, true)", [A]);
    expect((await c.query("select * from notes")).rowCount).toBeGreaterThan(0);
    await c.query("commit");
    expect((await c.query("select * from notes")).rowCount).toBe(0);
  } finally {
    await c.end();
  }
});

test("inside withWorkspace(A), workspace B's rows can be neither read nor updated", async () => {
  const b = await addNote(B, "b1");
  const seen = await withWorkspace(A, (tx) => tx.select().from(notes));
  expect(seen.every((n) => n.workspaceId === A)).toBe(true);

  const updated = await withWorkspace(A, (tx) =>
    tx.update(notes).set({ body: "hijacked" }).where(eq(notes.id, b.id)).returning(),
  );
  expect(updated).toHaveLength(0);
  const [still] = await withWorkspace(B, (tx) => tx.select().from(notes).where(eq(notes.id, b.id)));
  expect(still!.body).toBe("b1");
});

test("inside withWorkspace(A), a row for workspace B cannot be written", async () => {
  const write = withWorkspace(A, (tx) => tx.insert(notes).values({ workspaceId: B, body: "x", createdAt: now }));
  await expect(write).rejects.toSatisfy((e) => pgCode(e) === "42501");
});

test("a comment in workspace A pointing at B's note is refused by the database", async () => {
  const b = await addNote(B, "b2");
  const write = withWorkspace(A, (tx) =>
    tx.insert(noteComments).values({ workspaceId: A, noteId: b.id, body: "x", createdAt: now }),
  );
  await expect(write).rejects.toSatisfy((e) => pgCode(e) === "23503");
});

test("withWorkspace rejects a workspace id that is not a uuid", () => {
  expect(() => withWorkspace("not-a-uuid", async () => 1)).toThrow(/uuid/);
});
