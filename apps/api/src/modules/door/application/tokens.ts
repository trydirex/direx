// SPDX-License-Identifier: AGPL-3.0-only
// External tokens (ADR 0032 rule 005). Direx keeps only a token's SHA-256 and a short hint, so it
// can check a token but never show one again. 32 random bytes need no salt or slow hash. A token
// works only while its creator is still an Owner or Admin here, read on every check, so a removal
// or demotion stops it at once and giving the permission back starts it again.
import { createHash, randomBytes } from "node:crypto";
import { can, type Role } from "../../identity/index";
import * as repo from "../adapters/repo";
import { DOOR_KINDS, DOOR_READERS, type DoorKind, type DoorReader } from "../domain/catalogue";
import { lifetimeChoices, type TokenCaller } from "../domain/tokens";

const PREFIX = "dxt_";
const TOKEN = /^dxt_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const TOUCH_MS = 60_000;

/** The prefix lets secret scanners spot a leaked token. */
export const newToken = () => PREFIX + randomBytes(32).toString("base64url");
export const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
export const hintOf = (token: string) => token.slice(PREFIX.length, PREFIX.length + 4);

export type CreateInput = { name: string; days: number; readers: readonly string[]; kinds: readonly string[] };
export type CreateRefusal = "bad_name" | "bad_lifetime" | "unknown_reader" | "unknown_kind";
export type TokenState = "live" | "expired" | "revoked" | "stopped";

const isReader = (r: string): r is DoorReader => Object.hasOwn(DOOR_READERS, r);
const isKind = (k: string): k is DoorKind => (DOOR_KINDS as readonly string[]).includes(k);
const creatorMayHold = (role: string | null) => role !== null && can(role as Role, "workspace.settings");

export function createTokens(d: { maxDays: number | null; now?: () => Date }) {
  const now = d.now ?? (() => new Date());
  return {
    lifetimes: () => lifetimeChoices(d.maxDays),

    /** For an Owner or Admin after step-up; the route checks both. The token is in this result and nowhere else. */
    async create(workspaceId: string, input: CreateInput, userId: string): Promise<{ ok: true; id: string; token: string; expiresAt: Date } | { ok: false; reason: CreateRefusal }> {
      const name = input.name.trim();
      if (name.length < 1 || name.length > 60) return { ok: false, reason: "bad_name" };
      if (!lifetimeChoices(d.maxDays).includes(input.days)) return { ok: false, reason: "bad_lifetime" };
      if (!input.readers.every(isReader)) return { ok: false, reason: "unknown_reader" };
      if (!input.kinds.every(isKind)) return { ok: false, reason: "unknown_kind" };
      const token = newToken();
      const id = crypto.randomUUID();
      const at = now();
      const expiresAt = new Date(at.getTime() + input.days * DAY_MS);
      await repo.inWorkspace(workspaceId, (tx) =>
        repo.insertToken(tx, { id, workspaceId, name, tokenHash: hashOf(token), hint: hintOf(token), readers: [...new Set(input.readers)], kinds: [...new Set(input.kinds)], createdBy: userId, createdAt: at, expiresAt }),
      );
      return { ok: true, id, token, expiresAt };
    },

    async list(workspaceId: string) {
      const at = now();
      const rows = await repo.inWorkspace(workspaceId, repo.listTokens);
      return rows.map(({ creatorRole, ...t }) => {
        const state: TokenState = t.revokedAt ? "revoked" : t.expiresAt <= at ? "expired" : creatorMayHold(creatorRole) ? "live" : "stopped";
        return { ...t, state };
      });
    },

    /** Any Member may revoke; false only when there is no such token. */
    revoke: (workspaceId: string, tokenId: string, userId: string) =>
      UUID.test(tokenId) ? repo.inWorkspace(workspaceId, (tx) => repo.revokeToken(tx, workspaceId, tokenId, userId, now())) : Promise.resolve(false),

    /** The caller for a live token of this Workspace, or null; a token for another Workspace finds nothing. */
    async verify(workspaceId: string, raw: string): Promise<TokenCaller | null> {
      if (!UUID.test(workspaceId) || !TOKEN.test(raw)) return null;
      const at = now();
      return repo.inWorkspace(workspaceId, async (tx) => {
        const t = await repo.findByHash(tx, hashOf(raw));
        if (!t || t.expiresAt <= at || !creatorMayHold(t.creatorRole)) return null;
        await repo.touch(tx, t.id, at, TOUCH_MS);
        return { tokenId: t.id, workspaceId, name: t.name, readers: t.readers.filter(isReader), kinds: t.kinds.filter(isKind) };
      });
    },
  };
}

export type Tokens = ReturnType<typeof createTokens>;
