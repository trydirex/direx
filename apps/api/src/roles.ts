// SPDX-License-Identifier: AGPL-3.0-only
// The role a Direx process starts in (ADR 0027 rule 002): `all` serves HTTP and works every queue,
// `api` only serves HTTP, `worker` only works queues. Only the entry points read it; no module may.

import type { PgBoss } from "pg-boss";

type Env = Record<string, string | undefined>;
export type Role = "all" | "api" | "worker";

/** The process's role, read once at start. Unset is `all`, so self-host stays one process; a typo stops the start. */
export function roleFromEnv(env: Env = process.env): Role {
  const value = env.DIREX_ROLE ?? "all";
  if (value === "all" || value === "api" || value === "worker") return value;
  throw new Error(`DIREX_ROLE must be all, api or worker, not ${value}`);
}

/**
 * A split process shares nothing but Postgres and configured storage with the other side (ADR 0027
 * rule 005), so `api` and `worker` run on cloud only and with the root key in the environment or
 * supplied by an extension (`keySupplied`): a key file, or one generated under the data dir, exists on
 * one machine. Runs before anything can make one.
 */
export function assertRoleAllowed(role: Role, deployment: string, env: Env, keySupplied = false): void {
  if (role === "all") return;
  if (deployment !== "cloud") throw new Error(`DIREX_ROLE=${role} is for Direx cloud only. A self-hosted Direx runs as one process: unset DIREX_ROLE`);
  if (!keySupplied && !env.DIREX_MASTER_KEY) throw new Error(`DIREX_ROLE=${role} needs the root key in DIREX_MASTER_KEY, not a file, so every process reads the same key`);
}

/** Media on local disk would be seen by one side only, so a split process needs object storage (rule 005). */
export function assertSharedMedia(role: Role, s3Url: string | null): void {
  if (role !== "all" && !s3Url) throw new Error(`DIREX_ROLE=${role} needs media on object storage: set media.s3 with bun apps/api/src/secrets.ts set media.s3`);
}

/** A `worker` process answers only its health check, so an orchestrator can probe it; it serves no product route and no web app. */
export const healthOnly = (req: Request): Response => (new URL(req.url).pathname === "/health" ? Response.json({ ok: true }) : new Response("Not Found", { status: 404 }));

/**
 * The `api` role's boss: it still creates queues and sends to them, but registers no consumer and no
 * schedule. Every module holds this one instance, so none of them can.
 * ponytail: stubs the two methods on the instance; a module given its own boss would slip past it.
 */
export function sendOnly(boss: Pick<PgBoss, "work" | "schedule">): void {
  boss.work = (async () => "") as unknown as PgBoss["work"];
  boss.schedule = (async () => undefined) as PgBoss["schedule"];
}
