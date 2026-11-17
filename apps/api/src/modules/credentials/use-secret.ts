// SPDX-License-Identifier: AGPL-3.0-only
// The one way host code holds a credential's value outside the plugin seam. Its own entry
// point so dependency-cruiser can limit it to plugins, models and mcp-client.
import { resolverOf, type ResolveConsumer, type UsableValue, type Vault } from "./application/secrets";

/** Passes the value to fn and nowhere else; null when the credential cannot be used. */
export async function useSecret<T>(
  vault: Vault,
  workspaceId: string,
  credentialId: string,
  consumer: ResolveConsumer,
  fn: (value: UsableValue) => Promise<T>,
): Promise<T | null> {
  const r = await resolverOf(vault)(workspaceId, credentialId, consumer);
  return r ? fn(r.value) : null;
}
