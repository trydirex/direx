// SPDX-License-Identifier: MIT

// The plugin manifest: what a plugin is allowed to do, declared once and checked by the
// host at load. Every enum is closed and every object is strict, so a field or value
// this version does not know is an error, not something ignored.
import { z } from "zod";
import { MAX_EFFECT_TIMEOUT_MS } from "./effect";
import { QUERY_NAMES } from "./queries";

const name = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, "lowercase words separated by dots");
const semver = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "a semver version such as 1.2.3");
const hostPattern = z
  .string()
  .regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/, "an exact host or *.example.com");

export const dedupeClass = z.enum(["provider_idempotent", "queryable", "blind"]);
export const riskLevel = z.enum(["low", "medium", "high"]);

/** Other connections of the manifest the capability also runs on, such as an OAuth way into the same tool. */
const alsoConnections = z.array(z.string()).min(1).optional();

const effect = z.strictObject({
  kind: z.literal("effect"),
  name,
  connection: z.string(),
  alsoConnections,
  dedupe: dedupeClass,
  risk: riskLevel,
  /** The effect reaches a Person (an email, a call), so each Action must name the Person. */
  reachesPerson: z.boolean(),
  /** How long the provider honours an idempotency key; required for provider_idempotent. */
  keyWindowMs: z.number().int().positive().optional(),
  /** The effect spends money, so the host must call estimate and reserve budget first. */
  costs: z.boolean().optional(),
  /** How long one call may take, for a provider that makes the caller wait. */
  timeoutMs: z.number().int().positive().max(MAX_EFFECT_TIMEOUT_MS).optional(),
  /**
   * How long before its time the effect must be called, for a provider that only schedules ahead.
   * A caller that wants something to happen at a time hands it over this much earlier.
   */
  leadMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
  /** The effect reads the files its approved spec names, through links the host makes for each call. */
  media: z.literal("read").optional(),
});

const query = z.strictObject({
  kind: z.literal("query"),
  name: name.refine((n) => QUERY_NAMES.has(n), "not a query Direx knows; queries come from the SDK's catalogue"),
  connection: z.string(),
  alsoConnections,
});

const trigger = z.discriminatedUnion("source", [
  z.strictObject({
    kind: z.literal("trigger"),
    name,
    connection: z.string(),
    source: z.literal("poll"),
    pollIntervalMs: z.number().int().min(60_000),
  }),
  z.strictObject({
    kind: z.literal("trigger"),
    name,
    connection: z.string(),
    source: z.literal("webhook"),
    signature: z.strictObject({ scheme: z.literal("hmac_sha256"), header: z.string().min(1) }),
  }),
]);

export const manifestSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/, "reverse-DNS, lowercase"),
    /** What a person sees for this plugin, such as on the screen where they paste its key. */
    name: z.string().min(1).max(60).optional(),
    apiVersion: z.literal(1),
    version: semver,
    minHostVersion: semver,
    /** What the plugin says it is; the host decides from how it was loaded. */
    trust: z.enum(["first_party", "third_party"]),
    connections: z.array(z.strictObject({ key: z.string().min(1), auth: z.enum(["oauth2", "api_key", "header", "basic", "secret", "none"]) })),
    egress: z.strictObject({ hosts: z.array(hostPattern) }),
    capabilities: z.array(z.discriminatedUnion("kind", [effect, query, trigger])).min(1),
  })
  .superRefine((m, ctx) => {
    const connections = new Set(m.connections.map((c) => c.key));
    const seen = new Set<string>();
    m.capabilities.forEach((c, i) => {
      const at = ["capabilities", i];
      if (seen.has(c.name)) ctx.addIssue({ code: "custom", path: [...at, "name"], message: `duplicate capability ${c.name}` });
      seen.add(c.name);
      if (!connections.has(c.connection)) {
        ctx.addIssue({ code: "custom", path: [...at, "connection"], message: `no connection named ${c.connection}` });
      }
      ("alsoConnections" in c ? (c.alsoConnections ?? []) : []).forEach((k, j) => {
        if (!connections.has(k)) ctx.addIssue({ code: "custom", path: [...at, "alsoConnections", j], message: `no connection named ${k}` });
      });
      if (c.kind === "effect" && c.dedupe === "provider_idempotent" && c.keyWindowMs === undefined) {
        ctx.addIssue({ code: "custom", path: [...at, "keyWindowMs"], message: "required for provider_idempotent" });
      }
    });
    if (m.trust === "third_party" && m.egress.hosts.length === 0 && m.connections.some((c) => c.auth !== "none")) {
      ctx.addIssue({ code: "custom", path: ["egress", "hosts"], message: "a third-party plugin that connects must list its hosts" });
    }
  });

export type Manifest = z.infer<typeof manifestSchema>;
export type CapabilityDecl = Manifest["capabilities"][number];
export type EffectDecl = Extract<CapabilityDecl, { kind: "effect" }>;
export type TriggerDecl = Extract<CapabilityDecl, { kind: "trigger" }>;

export type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; errors: string[] };

/** Validates a manifest; each error names the field it is about. */
export function parseManifest(input: unknown): ManifestResult {
  const r = manifestSchema.safeParse(input);
  if (r.success) return { ok: true, manifest: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`) };
}
