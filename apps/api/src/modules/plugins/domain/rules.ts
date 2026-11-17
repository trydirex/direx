// SPDX-License-Identifier: AGPL-3.0-only
// Pure rules of the plugin host: which process may serve which workspace, when a
// plugin counts as unhealthy, and how manifests and versions compare.

/** One process per plugin per workspace: the pool key is both. */
export const poolKey = (pluginId: string, workspaceId: string) => `${pluginId} ${workspaceId}`;

/** A process serves only the workspace it was started for. Anything else is a host bug, so it throws. */
export function assertBound(boundWorkspaceId: string, requestedWorkspaceId: string): void {
  if (boundWorkspaceId !== requestedWorkspaceId) {
    throw new Error(`a plugin process started for workspace ${boundWorkspaceId} was asked to serve workspace ${requestedWorkspaceId}`);
  }
}

/** Adds a crash and keeps only those inside the window; unhealthy once `limit` are inside it. */
export function recordCrash(
  crashes: number[],
  at: number,
  rule: { limit: number; windowMs: number },
): { crashes: number[]; unhealthy: boolean } {
  const kept = [...crashes, at].filter((t) => at - t < rule.windowMs);
  return { crashes: kept, unhealthy: kept.length >= rule.limit };
}

/** JSON with object keys sorted, so two manifests compare by content. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** True when version a is at least b. Pre-release tags are ignored. */
export function atLeast(a: string, b: string): boolean {
  const parse = (v: string) => v.split("-")[0]!.split(".").map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! > y[i]!;
  return true;
}
