// SPDX-License-Identifier: MIT

// definePlugin ties handlers to a manifest, and invoke is the one place a host method
// reaches a handler. The stdio worker and the host's in-process loader both go through
// invoke, so a plugin behaves the same in and out of process.
import { z } from "zod";
import { skipMail, type SkipMail } from "./catalogue/mail";
import type { ExecuteResult, ReconcileResult } from "./effect";
import { parseManifest, type Manifest } from "./manifest";
import { mediaLink, type MediaLink } from "./media";
import { RPC_ERRORS, RpcError } from "./rpc";

/**
 * What a connection gets for one call, by its manifest `auth`: an access token for
 * oauth2 (never the refresh token), or the one value of an api_key, header, basic or
 * secret connection. The host sends it only inside that call. A basic connection may also
 * carry `settings`, plain non-secret values such as a server's host and port.
 */
export type Credential =
  | { accessToken: string; expiresAt: string }
  | { key: string }
  | { headerName: string; value: string }
  | { username: string; password: string; settings?: Record<string, string> }
  | { value: string };

/** The access token of an oauth2 credential, or null for none or another kind. */
export function accessToken(c: Credential | null): string | null {
  return c && "accessToken" in c ? c.accessToken : null;
}
export type PluginContext = { workspaceId: string; log: (message: string) => void };
export type CallContext = PluginContext & {
  idempotencyKey: string;
  credential: Credential | null;
  /** A link to each file the approved spec names, by media id, when the manifest grants media: "read". */
  media?: Readonly<Record<string, MediaLink>>;
};
export type TriggerEvent = { eventId: string; data: unknown };

export type EffectHandler = {
  /** No side effects. The spec it returns is what a person approves. */
  prepare(input: unknown, ctx: PluginContext): Promise<{ spec: unknown; preview: string; count?: { used: number; limit: number } }>;
  /** The one call that changes the outside world. */
  execute(spec: unknown, ctx: CallContext): Promise<ExecuteResult>;
  /** Required for queryable effects: did the effect with this correlation key happen? */
  reconcile?(correlationKey: string, ctx: CallContext, spec?: unknown): Promise<ReconcileResult>;
};
export type QueryHandler = (input: unknown, ctx: PluginContext & { credential: Credential | null }) => Promise<unknown>;
export type TriggerHandler = {
  /** Webhook triggers: the host has already verified the signature. */
  normalize?(payload: unknown, ctx: PluginContext): Promise<TriggerEvent[]>;
  /** Poll triggers: events since the cursor, and the cursor to pass next time. */
  poll?(
    cursor: string | null,
    ctx: PluginContext & { credential: Credential | null; skip?: readonly SkipMail[] },
  ): Promise<{ events: TriggerEvent[]; cursor: string }>;
};

export type PluginDefinition = {
  manifest: unknown;
  effects?: Record<string, EffectHandler>;
  queries?: Record<string, QueryHandler>;
  triggers?: Record<string, TriggerHandler>;
};
export type Plugin = Readonly<{
  manifest: Manifest;
  effects: Readonly<Record<string, EffectHandler>>;
  queries: Readonly<Record<string, QueryHandler>>;
  triggers: Readonly<Record<string, TriggerHandler>>;
}>;

/** Checks the handlers against the manifest both ways and freezes the result. */
export function definePlugin(def: PluginDefinition): Plugin {
  const parsed = parseManifest(def.manifest);
  if (!parsed.ok) throw new Error(`invalid manifest: ${parsed.errors.join("; ")}`);
  const m = parsed.manifest;
  const effects = def.effects ?? {};
  const queries = def.queries ?? {};
  const triggers = def.triggers ?? {};
  const problems: string[] = [];

  for (const c of m.capabilities) {
    if (c.kind === "effect") {
      const h = effects[c.name];
      if (!h) problems.push(`effect ${c.name} has no handler`);
      else if (c.dedupe === "queryable" && !h.reconcile) problems.push(`queryable effect ${c.name} has no reconcile`);
    } else if (c.kind === "query") {
      if (!queries[c.name]) problems.push(`query ${c.name} has no handler`);
    } else if (c.source === "poll" ? !triggers[c.name]?.poll : !triggers[c.name]?.normalize) {
      problems.push(`${c.source} trigger ${c.name} has no ${c.source === "poll" ? "poll" : "normalize"} handler`);
    }
  }
  const declared = (kind: string) => new Set(m.capabilities.filter((c) => c.kind === kind).map((c) => c.name));
  for (const [kind, handlers] of [["effect", effects], ["query", queries], ["trigger", triggers]] as const) {
    const names = declared(kind);
    for (const n of Object.keys(handlers)) if (!names.has(n)) problems.push(`${kind} handler ${n} is not in the manifest`);
  }
  if (problems.length) throw new Error(`plugin ${m.id}: ${problems.join("; ")}`);
  return Object.freeze({ manifest: m, effects: { ...effects }, queries: { ...queries }, triggers: { ...triggers } });
}

// On the wire a credential names its kind, so a field a newer host adds can't make one kind read as
// another; the handler gets it without the kind. Unknown fields are dropped (ADR 0028 rule 003).
const credential = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("oauth2"), accessToken: z.string(), expiresAt: z.string() }),
    z.object({ kind: z.literal("api_key"), key: z.string() }),
    z.object({ kind: z.literal("header"), headerName: z.string(), value: z.string() }),
    z.object({ kind: z.literal("basic"), username: z.string(), password: z.string(), settings: z.record(z.string(), z.string()).optional() }),
    z.object({ kind: z.literal("secret"), value: z.string() }),
  ])
  .nullable()
  .transform((c): Credential | null => {
    if (!c) return null;
    const { kind: _kind, ...rest } = c;
    return rest;
  });
export type CredentialKind = "oauth2" | "api_key" | "header" | "basic" | "secret";
// z.object drops a field this SDK does not know, so a newer host's advisory field is ignored. A
// restricting field such as skip is gated by the host on the reported SDK version instead.
const PARAMS = {
  prepare: z.object({ capability: z.string(), input: z.unknown() }),
  execute: z.object({ capability: z.string(), spec: z.unknown(), idempotencyKey: z.string(), credential, media: z.record(z.string(), mediaLink).optional() }),
  reconcile: z.object({
    capability: z.string(),
    correlationKey: z.string(),
    idempotencyKey: z.string(),
    credential,
    // Added for ADR 0025: the approved spec. Optional, so an older host still speaks to a newer plugin.
    spec: z.unknown().optional(),
  }),
  query: z.object({ capability: z.string(), input: z.unknown(), credential }),
  normalize: z.object({ capability: z.string(), payload: z.unknown() }),
  // skip is optional and sent only when non-empty, so a plugin built before it still loads.
  poll: z.object({ capability: z.string(), cursor: z.string().nullable(), credential, skip: z.array(skipMail).max(500).optional() }),
};
export type CapabilityMethod = keyof typeof PARAMS;

/** Runs one capability method on a plugin. Throws RpcError for an unknown method or bad params. */
export async function invoke(plugin: Plugin, method: string, params: unknown, ctx: PluginContext): Promise<unknown> {
  if (!Object.hasOwn(PARAMS, method)) throw new RpcError(RPC_ERRORS.methodNotFound, `method not found: ${method}`);
  const p = PARAMS[method as CapabilityMethod].safeParse(params);
  if (!p.success) throw new RpcError(RPC_ERRORS.invalidParams, `invalid params for ${method}`);
  const d = p.data as Record<string, unknown> & { capability: string };
  const missing = () => new RpcError(RPC_ERRORS.invalidParams, `no ${method} handler for ${d.capability}`);
  const cred = (d.credential ?? null) as Credential | null;
  const call: CallContext = { ...ctx, idempotencyKey: d.idempotencyKey as string, credential: cred, media: (d.media ?? {}) as Record<string, MediaLink> };

  const effect = plugin.effects[d.capability];
  const trigger = plugin.triggers[d.capability];
  const query = plugin.queries[d.capability];
  switch (method as CapabilityMethod) {
    case "prepare":
      if (!effect) throw missing();
      return effect.prepare(d.input, ctx);
    case "execute":
      if (!effect) throw missing();
      return effect.execute(d.spec, call);
    case "reconcile":
      if (!effect?.reconcile) throw missing();
      return effect.reconcile(d.correlationKey as string, call, d.spec);
    case "query":
      if (!query) throw missing();
      return { output: await query(d.input, { ...ctx, credential: cred }) };
    case "normalize":
      if (!trigger?.normalize) throw missing();
      return { events: await trigger.normalize(d.payload, ctx) };
    case "poll":
      if (!trigger?.poll) throw missing();
      return trigger.poll(d.cursor as string | null, { ...ctx, credential: cred, skip: (d.skip ?? []) as SkipMail[] });
  }
}
