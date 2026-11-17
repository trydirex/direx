// SPDX-License-Identifier: AGPL-3.0-only
// What a Server admin may install (ADR 0026 rule 003) and what a Workspace owner's turn-on is bound
// to (rule 002). Pure: the manifest comes from the probe, the suffix check from the caller.
import type { Manifest } from "@direx/plugin-sdk";
import { createHash } from "node:crypto";
import { stableJson } from "../domain/rules";

/** Capability shapes core reaches by name. In v1 only first-party plugins may offer them. */
const CORE_SHAPES = ["email.", "mailbox.", "placement.", "docs.", "search.", "social.", "newsletter."];
/** Id prefixes kept for Direx's own plugins. */
const RESERVED_IDS = ["com.trydirex.", "direx."];

export type InstallChecks = {
  /** Ids of the plugins this server ships, which an install may not take. */
  firstPartyIds: ReadonlySet<string>;
  /** True when a name is on the Public Suffix List, so `*.<name>` would cover strangers' sites. */
  isPublicSuffix: (name: string) => boolean;
};

/** Every reason this manifest can't be installed; empty when it can. */
export function installRefusals(m: Manifest, checks: InstallChecks): string[] {
  const out: string[] = [];
  if (m.trust !== "third_party") out.push('it says it is first-party; anything installed runs as "third_party"');
  if (RESERVED_IDS.some((p) => m.id.startsWith(p)) || checks.firstPartyIds.has(m.id)) out.push(`the id ${m.id} belongs to Direx's own plugins`);
  for (const c of m.capabilities) {
    if (CORE_SHAPES.some((p) => c.name.startsWith(p))) out.push(`${c.name} is a shape only Direx's own plugins may offer for now`);
    if (c.kind === "effect" && c.media) out.push(`${c.name} asks to read media, which third-party plugins can't yet`);
    if (c.kind === "effect" && c.costs) out.push(`${c.name} costs money per call, which this host can't budget yet`);
    // ponytail: installed plugins' triggers aren't registered on reload; wire them into triggers() when a plugin needs one.
    if (c.kind === "trigger") out.push(`${c.name} is a trigger, which third-party plugins can't have yet`);
  }
  for (const c of m.connections) {
    if (c.auth === "oauth2") out.push(`connection ${c.key} signs in with OAuth, which third-party plugins can't yet`);
    // The connect form takes one key; a plugin needing a login and password can take them as one key.
    else if (c.auth !== "api_key" && c.auth !== "none") out.push(`connection ${c.key} uses ${c.auth}, which third-party plugins can't connect yet; use api_key`);
  }
  for (const h of m.egress.hosts) {
    if (h.startsWith("*.") && checks.isPublicSuffix(h.slice(2))) out.push(`${h} would reach every site under ${h.slice(2)}`);
  }
  return out;
}

const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** What a Workspace owner agrees to: its capabilities, connections and hosts, in a fixed order. */
export function permissionHash(m: Manifest): string {
  const body = stableJson({
    capabilities: [...m.capabilities].sort(byKey((c) => `${c.kind} ${c.name}`)),
    connections: [...m.connections].sort(byKey((c) => c.key)),
    egress: [...m.egress.hosts].sort(),
  });
  return createHash("sha256").update(body).digest("hex");
}
