// SPDX-License-Identifier: AGPL-3.0-only
// Turns a manifest's effect declarations into the EffectCapability records the ledger's
// Dispatcher calls. What the effect is (dedupe class, key window) comes from the
// manifest, never from probing the plugin. The credential is fetched per call, checked
// against the kind the manifest declared, and sent only in that one request; a value it
// echoes back in a refusal is redacted before the ledger records it.
import { mediaRefs, type Credential, type EffectCapability, type EffectDecl, type ExecuteContext, type ExecuteResult, type Manifest, type MediaLink, type MediaRef, type ReconcileResult } from "@direx/plugin-sdk";
import { effectEntry } from "@direx/plugin-sdk/host";
import { z } from "zod";
import { CallFailed, credentialKind, NotStarted } from "./host";

export type CredentialUse = {
  consumer: "execute" | "reconcile" | "query" | "poll";
  actionId?: string;
  /** When set, the credential must have been connected for one of these connections (ADR 0026 rule 008). */
  connections?: readonly string[];
};
/** Supplies the named credential for one call; null when there is none or it cannot be used. */
export type Credentials = (workspaceId: string, credentialId: string | null, use: CredentialUse) => Promise<Credential | null>;
/** The connections a capability runs on: its own, and any it also runs on. */
export type RunsOn = { connection: string; alsoConnections?: readonly string[] };
/** What a loaded plugin asks for: a credential for one of the connections a capability runs on. */
export type ConnectionCredential = (
  workspaceId: string,
  on: RunsOn,
  credentialId: string | null,
  use: CredentialUse,
) => Promise<Credential | null>;
/** A short-lived link to one approved file, or null when it was deleted or changed since approval. */
export type MediaLinks = (workspaceId: string, ref: MediaRef) => Promise<MediaLink | null>;
/** One method call on a plugin, in or out of process. */
export type Call = (workspaceId: string, method: string, params: unknown) => Promise<unknown>;

const executeResult = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("sent"),
    providerRef: z.string().optional(),
    correlationKey: z.string().optional(),
    url: z.string().optional(),
    followUps: z.array(z.strictObject({ status: z.enum(["posted", "failed", "uncertain"]), url: z.string().optional(), detail: z.string().optional() })).optional(),
  }),
  z.strictObject({ kind: z.literal("refused"), permanent: z.boolean(), retryable: z.boolean(), detail: z.string().optional(), credentialRejected: z.boolean().optional(), providerLimit: z.enum(["sending_limit", "abuse"]).optional(), plan: z.string().min(1).max(40).optional() }),
]);
const reconcileResult = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("sent"), providerRef: z.string().optional(), url: z.string().optional() }),
  z.strictObject({ kind: z.literal("not_sent") }),
  z.strictObject({ kind: z.literal("unknown") }),
  z.strictObject({ kind: z.literal("refused"), detail: z.string().min(1).max(500) }),
]);

const prepared = z.strictObject({ spec: z.unknown(), preview: z.string(), count: z.strictObject({ used: z.number(), limit: z.number() }).optional() });
/** What prepare returns: the spec a person approves, its preview, and for a post its count against the network's limit. */
export type Prepared = z.infer<typeof prepared>;

/**
 * The one place an effect is prepared, whichever way its plugin runs. For an effect core prepares by name,
 * the input core built is parsed through its catalogue entry before the plugin sees it, and the spec the
 * plugin returned through the entry's spec before the ledger stores it (ADR 0028 rule 001). The spec goes
 * on exactly as the plugin returned it, since the approval binds its hash. Input that doesn't fit is core's
 * own bug, so it is a plain Error, never a CallFailed a caller could read as a Mailbox to reconnect; a spec
 * that doesn't fit is the provider's error. A plugin's own effect keeps its input and spec opaque.
 */
export async function prepareEffect(name: string, input: unknown, call: (input: unknown) => Promise<unknown>): Promise<Prepared> {
  const entry = effectEntry(name);
  if (entry && !entry.input.safeParse(input).success) throw new Error(`the input for ${name} does not fit its catalogue entry`);
  const r = prepared.safeParse(await call(input));
  if (!r.success) throw new CallFailed(`${name} did not prepare a spec and a preview`, { reason: "provider_error" });
  if (entry?.spec && !entry.spec.safeParse(r.data.spec).success) throw new CallFailed(`the spec ${name} prepared does not fit its catalogue entry`, { reason: "provider_error" });
  return r.data;
}

export const capabilityId = <N extends string>(pluginId: string, name: N): `${string}/${N}` => `${pluginId}/${name}`;

/** A credential whose kind is not the one the manifest declared for the connection. */
export class CredentialMismatch extends Error {}

const kindOf = credentialKind;

/**
 * `bound` is set for an installed plugin: its connection keys are stored under its own id, and the
 * vault hands it only a credential connected for one of them (ADR 0026 rule 008).
 */
export function credentialFor(manifest: Manifest, credentials: Credentials, bound = false): ConnectionCredential {
  const auth = new Map(manifest.connections.map((c) => [c.key, c.auth]));
  return async (workspaceId, on, credentialId, use) => {
    if (auth.get(on.connection) === "none") return null;
    const keys = [on.connection, ...(on.alsoConnections ?? [])];
    const declared = [...new Set(keys.map((k) => auth.get(k)))];
    const c = await credentials(workspaceId, credentialId, bound ? { ...use, connections: keys.map((k) => storedConnection(manifest.id, k)) } : use);
    if (c && !declared.includes(kindOf(c))) {
      throw new CredentialMismatch(`connection ${on.connection} declares ${declared.join(" or ")}, but the credential is ${kindOf(c)}`);
    }
    return c;
  };
}

/** Replaces any secret part of the credential found in text; expiry, header name, username and settings are not secret. */
export function redact(text: string | undefined, c: Credential | null): string | undefined {
  if (!text || !c) return text;
  let out = text;
  for (const [k, v] of Object.entries(c)) {
    if (k !== "expiresAt" && k !== "headerName" && k !== "username" && typeof v === "string" && v) out = out.replaceAll(v, "[redacted]");
  }
  return out;
}

const held = (detail: string): ExecuteResult => ({ kind: "refused", permanent: false, retryable: false, detail });

/**
 * Links to the files the approved spec names, for a capability whose manifest grants media: "read".
 * Any other capability gets none, whatever its spec holds. A file that can't be linked holds the
 * Action for a person rather than sending without it.
 */
async function linksFor(decl: EffectDecl, spec: unknown, workspaceId: string, mediaLinks: MediaLinks | undefined): Promise<Record<string, MediaLink> | ExecuteResult | undefined> {
  if (decl.media !== "read") return undefined;
  const refs = mediaRefs(spec);
  if (!refs.length) return undefined;
  if (!mediaLinks) return held("this host can't hand files to plugins");
  const out: Record<string, MediaLink> = {};
  for (const ref of refs) {
    let link: MediaLink | null;
    try {
      link = await mediaLinks(workspaceId, ref);
    } catch (e) {
      return held(`the approved file can't be read: ${(e as Error).message}`);
    }
    if (!link) return held("the approved file was deleted or changed after approval");
    out[ref.mediaId] = link;
  }
  return out;
}

export function toEffect(decl: EffectDecl, call: Call, credential: ConnectionCredential, onCredentialRejected?: (workspaceId: string, credentialId: string) => Promise<void>, mediaLinks?: MediaLinks): EffectCapability {
  const execute = async (spec: unknown, ctx: ExecuteContext): Promise<ExecuteResult> => {
    const media = await linksFor(decl, spec, ctx.workspaceId, mediaLinks);
    if (media && "kind" in media) return media as ExecuteResult;
    let token: Credential | null;
    try {
      token = await credential(ctx.workspaceId, decl, ctx.credentialId ?? null, { consumer: "execute", actionId: ctx.idempotencyKey });
    } catch (e) {
      const retryable = !(e instanceof CredentialMismatch);
      return { kind: "refused", permanent: false, retryable, detail: `no credential: ${(e as Error).message}` };
    }
    try {
      const r = await call(ctx.workspaceId, "execute", {
        capability: decl.name,
        spec,
        idempotencyKey: ctx.idempotencyKey,
        credential: token,
        ...(media && { media }),
      });
      // A malformed answer throws, which the Dispatcher records as an unknown outcome.
      const out = executeResult.parse(r);
      if (out.kind === "refused") {
        // The retry meets the credential check, which holds it until a reconnect resumes it.
        if (out.credentialRejected && ctx.credentialId) await onCredentialRejected?.(ctx.workspaceId, ctx.credentialId);
        return out.detail ? { ...out, detail: redact(out.detail, token) } : out;
      }
      return out.followUps ? { ...out, followUps: out.followUps.map((f) => (f.detail ? { ...f, detail: redact(f.detail, token)! } : f)) } : out;
    } catch (e) {
      if (e instanceof NotStarted) return { kind: "refused", permanent: false, retryable: e.retryable, detail: redact(e.message, token) };
      throw e;
    }
  };

  const reconcile = async (correlationKey: string, ctx: ExecuteContext, spec?: unknown): Promise<ReconcileResult> => {
    try {
      const token = await credential(ctx.workspaceId, decl, ctx.credentialId ?? null, { consumer: "reconcile", actionId: ctx.idempotencyKey });
      const r = await call(ctx.workspaceId, "reconcile", {
        capability: decl.name,
        correlationKey,
        idempotencyKey: ctx.idempotencyKey,
        credential: token,
        ...(spec !== undefined && { spec }),
      });
      return reconcileResult.parse(r);
    } catch {
      return { kind: "unknown" };
    }
  };

  const shared = { reachesPerson: decl.reachesPerson, ...(decl.timeoutMs && { timeoutMs: decl.timeoutMs }) };
  switch (decl.dedupe) {
    case "provider_idempotent":
      return { dedupe: "provider_idempotent", keyWindowMs: decl.keyWindowMs!, execute, ...shared };
    case "queryable":
      return { dedupe: "queryable", execute, reconcile, ...shared };
    case "blind":
      return { dedupe: "blind", execute, ...shared };
  }
}

/** Where an installed plugin's connection is stored in the vault: under its own id, so no key can collide. */
export const storedConnection = (pluginId: string, key: string) => `${pluginId}:${key}`;
