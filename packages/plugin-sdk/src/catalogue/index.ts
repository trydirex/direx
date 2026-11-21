// SPDX-License-Identifier: MIT
// The closed catalogue of queries a plugin may answer; the host refuses a manifest that names any
// other. Each entry is versioned and carries the input Direx sends and the answer it accepts.
// Beside them, the triggers core reads by name and their event data, and the effects core prepares by
// name with the input it passes and the spec fields it reads; any other trigger or effect is a
// plugin's own, and its data and spec stay opaque.
import type { z, ZodType } from "zod";
import { docsPageText, docsRows, docsRowUpdate, docsSources } from "./docs";
import type { EffectEntry, QueryEntry, TriggerEntry } from "./entry";
import { emailReceived, mailFrom, mailSent } from "./mail";
import { mailboxProbeRead, mailboxProfile } from "./mailbox";
import { emailSend, mailboxProbe, placementArchive, placementJoin, placementReport, placementSend, touch } from "./message";
import { newsletterCancel, newsletterDraft, newsletterLists, newsletterProfile, newsletterPublish, newsletterSend, newsletterStats, newsletterSubscribers } from "./newsletter";
import { placementRead } from "./placement";
import { searchAnalytics, searchProperties } from "./search";
import { socialHealth, socialIdentity, socialPosts, socialPublish } from "./social";
import { verifyAddress, verifyBalance } from "./verify";

const entries = [
  mailFrom,
  mailboxProfile,
  mailboxProbeRead,
  placementRead,
  verifyAddress,
  verifyBalance,
  searchProperties,
  searchAnalytics,
  newsletterSubscribers,
  newsletterProfile,
  newsletterStats,
  newsletterLists,
  socialIdentity,
  socialHealth,
  socialPosts,
  docsSources,
  docsPageText,
  docsRows,
] as const satisfies readonly QueryEntry[];

type Entries = (typeof entries)[number];
export type Catalogue = { readonly [E in Entries as E["name"]]: E };
export type QueryName = keyof Catalogue;
/** What Direx code sends a query. */
export type QueryInput<N extends QueryName> = z.input<Catalogue[N]["input"]>;
/** A query's answer, as the host hands it on after parsing it. */
export type QueryOutput<N extends QueryName> = z.output<Catalogue[N]["output"]>;

export const CATALOGUE = Object.fromEntries(entries.map((e) => [e.name, e])) as Catalogue;

/** The entry for a query name, or undefined for a name the catalogue doesn't hold. */
export const queryEntry = (name: string): QueryEntry | undefined => (Object.hasOwn(CATALOGUE, name) ? (CATALOGUE as Record<string, QueryEntry>)[name] : undefined);

/** A query's input and output schemas, for a plugin answering it; an agent query's text stays with the host. */
export function querySchemas<N extends QueryName>(name: N): Pick<Catalogue[N], "input" | "output"> {
  const { input, output } = CATALOGUE[name];
  return { input, output };
}

const triggerEntries = [emailReceived, mailSent] as const satisfies readonly TriggerEntry[];

type TriggerEntries = (typeof triggerEntries)[number];
export type Triggers = { readonly [E in TriggerEntries as E["name"]]: E };
export type TriggerName = keyof Triggers;
/** An event's data, as the host hands it on after parsing it. */
export type TriggerData<N extends TriggerName> = z.output<Triggers[N]["data"]>;

export const TRIGGERS = Object.fromEntries(triggerEntries.map((e) => [e.name, e])) as Triggers;
/** Every trigger name core reads by name. */
export const TRIGGER_NAMES: ReadonlySet<string> = new Set(triggerEntries.map((e) => e.name));

/** The entry for a trigger core reads by name, or undefined for a plugin's own trigger. */
export const triggerEntry = (name: string): TriggerEntry | undefined => (Object.hasOwn(TRIGGERS, name) ? (TRIGGERS as Record<string, TriggerEntry>)[name] : undefined);

const effectEntries = [
  emailSend,
  mailboxProbe,
  placementJoin,
  placementSend,
  placementReport,
  placementArchive,
  newsletterDraft,
  newsletterSend,
  newsletterPublish,
  newsletterCancel,
  socialPublish,
  docsRowUpdate,
] as const satisfies readonly EffectEntry[];

type EffectEntries = (typeof effectEntries)[number];
export type Effects = { readonly [E in EffectEntries as E["name"]]: E };
export type EffectName = keyof Effects;
/** What Direx passes to an effect's prepare. */
export type EffectInput<N extends EffectName> = z.input<Effects[N]["input"]>;
/** The effects whose approved spec Direx reads. */
export type SpecName = Extract<EffectEntries, { spec: ZodType }>["name"];
/** The fields Direx reads from an effect's approved spec; the plugin's spec may carry more. */
export type EffectSpec<N extends SpecName> = z.output<Effects[N]["spec"]>;
export type Touch = z.output<typeof touch>;

export const EFFECTS = Object.fromEntries(effectEntries.map((e) => [e.name, e])) as Effects;
/** Every effect name core prepares by name. */
export const EFFECT_NAMES: ReadonlySet<string> = new Set(effectEntries.map((e) => e.name));

/** The entry for an effect core prepares by name, or undefined for a plugin's own effect. */
export const effectEntry = (name: string): EffectEntry | undefined => (Object.hasOwn(EFFECTS, name) ? (EFFECTS as Record<string, EffectEntry>)[name] : undefined);

/** An effect's input schema and the spec fields Direx reads, for a plugin preparing it. */
export const effectSchemas = <N extends EffectName>(name: N): Effects[N] => EFFECTS[name];

const fieldOf = (v: unknown, key: string): unknown => (typeof v === "object" && v !== null && Object.hasOwn(v, key) ? Reflect.get(v, key) : undefined);

/**
 * The fields Direx reads from a stored spec, each parsed through the entry on its own: one that is missing
 * or doesn't fit is left out, so a spec stored before the entries existed still reads as far as it can.
 * New specs were checked whole when they were prepared.
 */
export function storedSpec<N extends SpecName>(name: N, spec: unknown): Partial<EffectSpec<N>> {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(EFFECTS[name].spec.shape)) {
    const r = (schema as ZodType).safeParse(fieldOf(spec, key));
    if (r.success && r.data !== undefined) out[key] = r.data;
  }
  return out as Partial<EffectSpec<N>>;
}

/** A spec's Touch, whole and valid, or undefined: what Touch caps and suppression read. */
export const touchOf = (spec: unknown): Touch | undefined => touch.safeParse(fieldOf(spec, "touch")).data;

/** One field of a spec's Touch, read on its own: whom it reaches, or its class, even where the rest is missing. */
export const touchField = <K extends keyof Touch>(spec: unknown, key: K): Touch[K] | undefined => touch.shape[key].safeParse(fieldOf(fieldOf(spec, "touch"), key)).data as Touch[K] | undefined;
