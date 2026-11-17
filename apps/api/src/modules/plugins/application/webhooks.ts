// SPDX-License-Identifier: AGPL-3.0-only
// Webhook addresses for plugin triggers (ADR 0031 rule 007). An Admin makes one per trigger per
// Workspace; its URL names the stored row, and only the row says which plugin and trigger a delivery
// is for. The signing secret is a Workspace credential, shown once when made or rotated, and checked
// inside the vault. A delivery seen before is dropped by its event ids (trigger_events).
import { randomBytes } from "node:crypto";
import type { Vault } from "../../credentials";
import { inWorkspace, insertWebhook, webhookById, webhookFor, webhooksIn } from "../adapters/trigger-repo";
import type { VerifyWebhook, WebhookResult } from "./triggers";

export const WEBHOOK_MAX_BYTES = 256 * 1024;

type Intake = {
  hasWebhook: (pluginId: string, trigger: string) => boolean;
  ingestWebhook: (req: { workspaceId: string; pluginId: string; trigger: string; headers: Record<string, string | undefined>; rawBody: Uint8Array }) => Promise<WebhookResult>;
};

export function createPluginWebhooks(deps: { vault: () => Pick<Vault, "create" | "rotate" | "find" | "remove">; plugins: () => Intake; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const freshSecret = () => randomBytes(32).toString("hex");

  return {
    list: (workspaceId: string) =>
      inWorkspace(workspaceId, async (tx) => (await webhooksIn(tx)).map((w) => ({ id: w.id, pluginId: w.pluginId, trigger: w.trigger, createdAt: w.createdAt.toISOString() }))),

    /** One webhook per trigger per Workspace; its secret is returned here and never again. */
    async create(workspaceId: string, pluginId: string, trigger: string, userId: string) {
      if (!deps.plugins().hasWebhook(pluginId, trigger)) return { ok: false, reason: "unknown_trigger" } as const;
      if (await inWorkspace(workspaceId, (tx) => webhookFor(tx, pluginId, trigger))) return { ok: false, reason: "exists" } as const;
      const id = crypto.randomUUID();
      const secret = freshSecret();
      const made = await deps.vault().create({ workspaceId, actorUserId: userId, scope: "workspace", kind: "secret", key: `plugin_webhook:${id}`, name: `Webhook for ${trigger}`, meta: {}, value: { value: secret } });
      if (!made.ok) throw new Error(`the webhook's secret was not stored: ${made.reason}`);
      const stored = await inWorkspace(workspaceId, (tx) => insertWebhook(tx, { id, workspaceId, pluginId, trigger, credentialId: made.credential.id, createdAt: now(), createdBy: userId }));
      if (stored) return { ok: true, id, secret } as const;
      // Another Admin made this trigger's webhook at the same moment; theirs stands.
      await deps.vault().remove({ workspaceId, id: made.credential.id, actorUserId: userId });
      return { ok: false, reason: "exists" } as const;
    },

    /** A new secret; the old one stops working at once. */
    async rotate(workspaceId: string, hookId: string, userId: string) {
      const hook = await inWorkspace(workspaceId, (tx) => webhookById(tx, hookId));
      const cred = hook && (await deps.vault().find(workspaceId, hook.credentialId));
      if (!cred) return { ok: false, reason: "not_found" } as const;
      const secret = freshSecret();
      const r = await deps.vault().rotate({ workspaceId, id: cred.id, version: cred.version, value: { value: secret }, actorUserId: userId });
      if (!r.ok) return { ok: false, reason: r.reason === "stale_version" ? "stale_version" : "not_found" } as const;
      return { ok: true, id: hookId, secret } as const;
    },

    /** One delivery. An unknown address reads as a bad signature, so a guess learns nothing. */
    async receive(workspaceId: string, hookId: string, rawBody: Uint8Array, headers: Record<string, string | undefined>): Promise<WebhookResult | { ok: false; reason: "too_large" }> {
      if (rawBody.byteLength > WEBHOOK_MAX_BYTES) return { ok: false, reason: "too_large" };
      const hook = await inWorkspace(workspaceId, (tx) => webhookById(tx, hookId));
      if (!hook) return { ok: false, reason: "bad_signature" };
      return deps.plugins().ingestWebhook({ workspaceId, pluginId: hook.pluginId, trigger: hook.trigger, headers, rawBody });
    },
  };
}

export type PluginWebhooks = ReturnType<typeof createPluginWebhooks>;

/** The check `ingestWebhook` runs: the trigger's stored webhook, its secret checked in the vault. */
export function webhookVerifier(vault: () => Pick<Vault, "verifyHmac">): VerifyWebhook {
  return async (workspaceId, pluginId, trigger, rawBody, signature) => {
    const hook = await inWorkspace(workspaceId, (tx) => webhookFor(tx, pluginId, trigger));
    return hook ? vault().verifyHmac(workspaceId, hook.credentialId, rawBody, signature) : null;
  };
}
