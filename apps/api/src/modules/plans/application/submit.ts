// SPDX-License-Identifier: AGPL-3.0-only
// What a Strategy and a plan share once a version is written: its digest, its warnings, and the
// one Item waiting on it. These Items always carry a warning, because a plan is read, not bulk accepted.
import { createHash } from "node:crypto";
import { warn, type Items } from "../../items";
import { inWorkspace, openVersionItems } from "../adapters/repo";

export type Person = { userId: string };
export type VersionPayload = { targetId: string; version: number };

export const READ_FIRST = "Read this before approving";
export const STRATEGY_KIND = "strategy_version";
export const PLAN_KIND = "plan_version";

export const digestOf = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");

/** The Item a person would approve now, so a page can show it next to the words it binds. */
export async function waitingItem(items: Items, workspaceId: string, kind: string, targetId: string) {
  const open = await inWorkspace(workspaceId, (tx) => openVersionItems(tx, kind, targetId));
  const last = open.at(-1);
  const view = last && (await items.view(workspaceId, last.id));
  return view && last ? { id: view.id, revision: view.revision, version: last.version, warnings: view.warnings.map((w) => w.text) } : null;
}

/** The Item for a version, replacing any older one still waiting. Submitting twice makes one Item. */
export async function itemForVersion(
  items: Items,
  workspaceId: string,
  a: { kind: string; targetId: string; version: number; title: string; warnings: string[]; actor: Person },
) {
  const open = await inWorkspace(workspaceId, (tx) => openVersionItems(tx, a.kind, a.targetId));
  const same = open.find((o) => o.version === a.version);
  if (same) return (await items.view(workspaceId, same.id))!;
  for (const o of open) await items.cancel(workspaceId, o.id, a.actor);
  const payload: VersionPayload = { targetId: a.targetId, version: a.version };
  const r = await items.createItem(workspaceId, {
    kind: a.kind,
    payload,
    actor: a.actor,
    // A plan version names its plan, so a page can link straight to it; the Strategy has one page.
    details: { title: a.title, workArea: "Plans", warnings: [READ_FIRST, ...a.warnings].map((w) => warn("unspecified", w)), ...(a.kind === PLAN_KIND ? { groupKey: `plan:${a.targetId}` } : {}) },
  });
  if (!r.ok) throw new Error(`plans: ${r.reason}: the item kinds aren't registered`);
  return r.item;
}
