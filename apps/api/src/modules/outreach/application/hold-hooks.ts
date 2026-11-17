// SPDX-License-Identifier: AGPL-3.0-only
// The relationship-hold webhook: another CRM, through Zapier or Make, says "we're talking to these
// addresses". Add-only, so a leaked secret can stop email but never start it. The secret is a
// Workspace credential, shown once when made or rotated, and checked inside the vault.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Vault } from "../../credentials";
import { lockGroup, normaliseKey, personIdWithEmail, sharedMailDomain } from "../../people";
import { hookById, insertHolds, insertHook, liveHook } from "../adapters/holds-repo";
import { inWorkspace } from "../adapters/repo";
import { companyOf } from "../domain/holds";
import { hasherFor } from "./holds";
import type { ReplyStop } from "./outside-touches";

export const HOOK_MAX_BYTES = 64 * 1024;
const DAY = 86_400_000;

const HookBody = z.strictObject({
  holds: z
    .array(z.strictObject({ email: z.string().max(320), reason: z.string().trim().min(1).max(200), days: z.number().int().min(1).max(90).default(30) }))
    .min(1)
    .max(100),
});

export function createHoldHooks(deps: { vault: () => Pick<Vault, "create" | "rotate" | "find" | "verifyHmac">; replies: () => ReplyStop; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const freshSecret = () => randomBytes(32).toString("hex");

  return {
    status: (workspaceId: string) =>
      inWorkspace(workspaceId, async (tx) => {
        const h = await liveHook(tx);
        return { hook: h ? { id: h.id, createdAt: h.createdAt.toISOString() } : null };
      }),

    /** One working hook per Workspace; its secret is returned here and never again. */
    async create(workspaceId: string, userId: string) {
      if (await inWorkspace(workspaceId, liveHook)) return { ok: false, reason: "exists" } as const;
      const id = crypto.randomUUID();
      const secret = freshSecret();
      const made = await deps.vault().create({ workspaceId, actorUserId: userId, scope: "workspace", kind: "secret", key: `hold_hook:${id}`, name: "Relationship hold webhook", meta: {}, value: { value: secret } });
      if (!made.ok) throw new Error(`the hold webhook's secret was not stored: ${made.reason}`);
      await inWorkspace(workspaceId, (tx) => insertHook(tx, { id, workspaceId, credentialId: made.credential.id, createdAt: now(), createdBy: userId }));
      return { ok: true, id, secret } as const;
    },

    /** A new secret; the old one stops working at once. */
    async rotate(workspaceId: string, hookId: string, userId: string) {
      const hook = await inWorkspace(workspaceId, (tx) => hookById(tx, hookId));
      const cred = hook && (await deps.vault().find(workspaceId, hook.credentialId));
      if (!cred) return { ok: false, reason: "not_found" } as const;
      const secret = freshSecret();
      const r = await deps.vault().rotate({ workspaceId, id: cred.id, version: cred.version, value: { value: secret }, actorUserId: userId });
      if (!r.ok) return { ok: false, reason: r.reason === "stale_version" ? "stale_version" : "not_found" } as const;
      return { ok: true, id: hookId, secret } as const;
    },

    /**
     * One delivery. Each address gets a certain hold for `days`; sending it again extends a hold and
     * never shortens it. People already in Direx leave their campaigns; an address Direx hasn't seen
     * is held when it arrives.
     */
    async receive(workspaceId: string, hookId: string, body: Uint8Array, signature: string | undefined) {
      if (body.byteLength > HOOK_MAX_BYTES) return { ok: false, reason: "too_large" } as const;
      const hook = await inWorkspace(workspaceId, (tx) => hookById(tx, hookId));
      const given = (signature ?? "").trim().replace(/^sha256=/i, "").toLowerCase();
      if (!hook || !(await deps.vault().verifyHmac(workspaceId, hook.credentialId, body, given))) return { ok: false, reason: "bad_signature" } as const;

      let parsed;
      try {
        parsed = HookBody.safeParse(JSON.parse(new TextDecoder().decode(body)));
      } catch {
        return { ok: false, reason: "bad_body" } as const;
      }
      if (!parsed.success) return { ok: false, reason: "bad_body" } as const;
      // One row per address, so the insert never touches a row twice; the longest days wins.
      const byEmail = new Map<string, { reason: string; days: number }>();
      for (const h of parsed.data.holds) {
        const email = normaliseKey("email", h.email);
        if (!email.ok) return { ok: false, reason: "bad_body" } as const;
        const seen = byEmail.get(email.value);
        if (!seen || h.days > seen.days) byEmail.set(email.value, { reason: h.reason, days: h.days });
      }

      const at = now();
      const toCancel = await inWorkspace(workspaceId, async (tx) => {
        const hash = await hasherFor(tx, workspaceId, at);
        await insertHolds(
          tx,
          [...byEmail].map(([email, h]) => ({
            workspaceId,
            emailHash: hash(email),
            domain: companyOf(email, sharedMailDomain),
            personId: null,
            source: "webhook",
            sourceRef: hookId,
            reason: h.reason,
            startedAt: at,
            expiresAt: new Date(at.getTime() + h.days * DAY),
            createdBy: null,
          })),
        );
        const people = new Set<string>();
        for (const email of byEmail.keys()) {
          const id = await personIdWithEmail(tx, email);
          if (id) people.add(id);
        }
        // Sorted, so two deliveries at once take the group locks in the same order.
        const members = new Set<string>();
        for (const p of [...people].sort()) for (const m of (await lockGroup(tx, p)).members) members.add(m);
        return members.size ? deps.replies().mark(tx, [...members], "removed") : [];
      });
      if (toCancel.length) await deps.replies().cancel(workspaceId, toCancel);
      return { ok: true, held: byEmail.size } as const;
    },
  };
}

export type HoldHooks = ReturnType<typeof createHoldHooks>;
