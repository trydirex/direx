// SPDX-License-Identifier: AGPL-3.0-only
// Pure: whether a proposal may rely on fact_id@version. It must have been read by this run, and
// still be the fact's current version.
import type { ManifestPart } from "./manifest";

export type CitationCheck = "ok" | "malformed" | "outside_manifest" | "stale";

export function checkManifestCitation(cited: string, manifest: readonly Pick<ManifestPart, "kind" | "refId" | "version">[], currentVersion: (factId: string) => number | undefined): CitationCheck {
  const match = /^([^@]+)@([1-9]\d*)$/.exec(cited);
  if (!match) return "malformed";
  const [, factId, version] = match;
  if (!manifest.some((p) => p.kind === "fact" && p.refId === factId && p.version === version)) return "outside_manifest";
  return currentVersion(factId!) === Number(version) ? "ok" : "stale";
}
