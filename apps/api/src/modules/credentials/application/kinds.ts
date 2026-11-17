// SPDX-License-Identifier: AGPL-3.0-only
// What each kind of credential stores. The value is encrypted; meta is plain and shown
// in the catalog. Both schemas are strict, so a field nobody declared (a "token" slipped
// into meta, say) is refused rather than stored in the clear. A basic credential may also
// hold plain settings, such as a server's host, and an oauth2 one what was chosen for its
// account, such as a Search Console property, as long as no name looks like a secret.
import { z } from "zod";

const text = z.string().min(1);
const SECRET_NAME = /token|secret|password|key|authorization/i;
const noSecretNames = (m: object) => !Object.keys(m).some((name) => SECRET_NAME.test(name));

const VALUE = {
  oauth2: z.strictObject({ refreshToken: text.optional(), accessToken: text, expiresAt: z.iso.datetime() }),
  api_key: z.strictObject({ key: text }),
  header: z.strictObject({ value: text }),
  basic: z.strictObject({ password: text }),
  secret: z.strictObject({ value: text }),
};

const META = {
  oauth2: z
    .object({
      accountEmail: z.email().optional(),
      accountId: text.optional(),
      accountLabel: text.optional(),
      /** When the network ends this grant, whatever the token's own expiry says. */
      grantExpiresAt: z.iso.datetime().optional(),
      scopes: z.array(text).min(1),
    })
    .catchall(z.string().max(2048))
    .refine((m) => m.accountEmail || m.accountId, "an account email or id")
    .refine(noSecretNames, "a field name looks like a secret"),
  // Only the list chosen inside the account, such as a Mailchimp audience, and its name for the words
  // a person reads. Named, not a catchall, so nothing else reaches plain meta.
  api_key: z.strictObject({ listId: z.string().min(1).max(100).optional(), listName: z.string().min(1).max(200).optional() }),
  header: z.strictObject({ headerName: z.string().regex(/^[A-Za-z0-9-]+$/) }),
  basic: z
    .object({ username: text })
    .catchall(z.string().max(300))
    .refine(noSecretNames, "a field name looks like a secret"),
  secret: z.strictObject({}),
};

export type Kind = keyof typeof VALUE;
export const KINDS = Object.keys(VALUE) as Kind[];
export type SecretValue<K extends Kind = Kind> = z.infer<(typeof VALUE)[K]>;
export type Meta<K extends Kind = Kind> = z.infer<(typeof META)[K]>;

export type KindRefusal = "unknown_kind" | "bad_value" | "bad_meta";
export type Parsed<K extends Kind> =
  | { ok: true; kind: K; value: SecretValue<K>; meta: Meta<K> }
  // detail names fields and issue codes only: a value must never reach an error message.
  | { ok: false; reason: KindRefusal; detail: string };

const describe = (e: z.ZodError) =>
  e.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.code}${i.code === "unrecognized_keys" ? ` ${i.keys.join(",")}` : ""}`)
    .join("; ");

/** The fields of a stored meta that the kind doesn't name itself, such as a choice saved beside an account. */
export function extraMeta(kind: Kind, meta: unknown): Record<string, unknown> {
  const own = new Set(Object.keys(META[kind].shape));
  return Object.fromEntries(Object.entries((meta ?? {}) as Record<string, unknown>).filter(([name]) => !own.has(name)));
}

/** A kind's meta on its own, for changing meta without touching the sealed value. */
export function parseMeta<K extends Kind>(kind: K, meta: unknown): { ok: true; meta: Meta<K> } | { ok: false; reason: KindRefusal; detail: string } {
  if (!Object.hasOwn(META, kind)) return { ok: false, reason: "unknown_kind", detail: "kind" };
  const m = META[kind].safeParse(meta);
  return m.success ? { ok: true, meta: m.data as Meta<K> } : { ok: false, reason: "bad_meta", detail: describe(m.error) };
}

export function parseKind<K extends Kind>(kind: K, value: unknown, meta: unknown): Parsed<K> {
  const m = parseMeta(kind, meta);
  if (!m.ok) return m;
  const v = VALUE[kind].safeParse(value);
  if (!v.success) return { ok: false, reason: "bad_value", detail: describe(v.error) };
  return { ok: true, kind, value: v.data as SecretValue<K>, meta: m.meta };
}
