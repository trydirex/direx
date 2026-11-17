// SPDX-License-Identifier: AGPL-3.0-only
// Where a provider key comes from, always the vault and held only for the one call. On cloud
// it is Direx's own, in the system Workspace, and a Workspace cannot add one. On self-host it
// is the Workspace's own credential.
import { listSystemSecrets, readSystemSecret } from "../../credentials/system-secrets";
import { useSecret } from "../../credentials/use-secret";
import type { Vault } from "../../credentials/index";
import type { Deployment } from "../domain/budget";
import { isCliProvider, type Provider } from "../domain/routes-check";
import { cliSignIns, connections } from "./repo";
import { oneAtATime } from "./runtime/registry";

export type CredentialKind = "cloud_contract" | "byok_api_key" | "openrouter" | "cli_subscription";

const CONTRACTED = ["anthropic", "openai", "google"] as const;

export type Keys = {
  /** The providers this Workspace has a key for. A CLI counts if this actor's run could use a sign-in. */
  available(workspaceId: string, actorUserId?: string): Promise<Set<Provider>>;
  /** Runs fn with the key; null when the key can no longer be used. replaceKey stores a sign-in the CLI refreshed. */
  withKey<T>(workspaceId: string, provider: Provider, fn: (apiKey: string, replaceKey?: (value: string) => Promise<void>) => Promise<T>, actorUserId?: string): Promise<T | null>;
  kindOf(provider: Provider): CredentialKind;
  /** Whether a sign-in works, told after each call so its Needs you entry opens and clears. */
  signInOutcome?(workspaceId: string, provider: Provider, actorUserId: string | undefined, works: boolean): Promise<void>;
};

type SignIn = { provider: string; ownerUserId: string | null };

/** A person's own sign-in first, then the shared one. A run nobody started uses only the shared one. */
export function signInFor<T extends SignIn>(rows: readonly T[], provider: string, actorUserId?: string): T | undefined {
  const forProvider = rows.filter((r) => r.provider === provider);
  return forProvider.find((r) => actorUserId && r.ownerUserId === actorUserId) ?? forProvider.find((r) => r.ownerUserId === null);
}

export function createKeys(a: { deployment: Deployment; vault?: () => Vault; signInOutcome?: Keys["signInOutcome"] }): Keys {
  if (a.deployment === "cloud") {
    return {
      available: async () => {
        if (!a.vault) return new Set();
        const names = (await listSystemSecrets(a.vault())).map((r) => r.name as string);
        return new Set(CONTRACTED.filter((p) => names.includes(`provider.${p}`)));
      },
      withKey: async (_ws, p, fn) => {
        if (!a.vault || !(CONTRACTED as readonly Provider[]).includes(p)) return null;
        const k = await readSystemSecret(a.vault(), `provider.${p as (typeof CONTRACTED)[number]}`, "model_call");
        return k ? fn(k) : null;
      },
      kindOf: () => "cloud_contract",
    };
  }
  return {
    available: async (ws, actor) => {
      const signIns = await cliSignIns(ws);
      const cli = signIns.filter((s) => signInFor(signIns, s.provider, actor)).map((s) => s.provider);
      return new Set([...(await connections(ws)).map((c) => c.provider), ...cli] as Provider[]);
    },
    signInOutcome: a.signInOutcome,
    withKey: async (ws, p, fn, actor) => {
      if (isCliProvider(p)) {
        const signIn = signInFor(await cliSignIns(ws), p, actor);
        if (!signIn || !a.vault) return null;
        const { credentialId } = signIn;
        const vault = a.vault();
        const replace = async (value: string) => {
          const found = await vault.find(ws, credentialId);
          if (found) await vault.rotate({ workspaceId: ws, id: credentialId, version: found.version, value: { value }, actorUserId: null });
        };
        const use = () => useSecret(vault, ws, credentialId, "model_call", async (v) => ("value" in v ? fn(v.value, replace) : null));
        // The sign-in is read inside the turn: a queued Codex call must see the last call's refresh.
        return p === "codex" ? oneAtATime(credentialId, use) : use();
      }
      const conn = (await connections(ws)).find((c) => c.provider === p);
      if (!conn || !a.vault) return null;
      return useSecret(a.vault(), ws, conn.credentialId, "model_call", async (v) => ("key" in v ? fn(v.key) : null));
    },
    kindOf: (p) => (isCliProvider(p) ? "cli_subscription" : p === "openrouter" ? "openrouter" : "byok_api_key"),
  };
}
