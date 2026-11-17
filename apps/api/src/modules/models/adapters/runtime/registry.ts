// SPDX-License-Identifier: AGPL-3.0-only
// The list on screen, and the one place a call is sent to a CLI instead of the SDK.
import { isCliProvider } from "../../domain/routes-check";
import type { Dispatch } from "../sdk";
import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import { NOT_INSTALLED_REASON } from "./envelope";
import { sandboxStatus } from "./sandbox";
import type { ModelAdapter } from "./types";

export const ADAPTERS: readonly ModelAdapter[] = [claudeCode, codex];

export const withCliAdapters = (base: Dispatch, adapters: readonly ModelAdapter[] = ADAPTERS): Dispatch => (r) => {
  if (!isCliProvider(r.provider)) return base(r);
  const adapter = adapters.find((a) => a.id === r.provider);
  return adapter ? adapter.call(r) : Promise.resolve({ ok: false, family: "configuration", definite: true });
};

/** What stops an adapter running here at all, in words a person can act on. Null when nothing does. */
export async function adapterBlocked(adapter: ModelAdapter): Promise<string | null> {
  if (!(await adapter.installed())) return NOT_INSTALLED_REASON;
  const box = await sandboxStatus();
  return box.ok ? null : box.reason;
}

const queues = new Map<string, Promise<unknown>>();

/** Runs fn after every earlier call with this key has finished, whatever their outcome. */
// ponytail: in-process only, a row lock if the API ever runs as several processes.
export function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const settled = run.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}
