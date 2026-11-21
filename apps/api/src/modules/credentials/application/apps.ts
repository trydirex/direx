// SPDX-License-Identifier: AGPL-3.0-only
// Who owns the OAuth app a connection uses. A template (AppProvider) says what the connection
// is; an app source says whose client pair it runs with. The vault asks the Workspace's own app
// first, then each source here in order, and a new connect uses the first app it finds.
import type { ClientPair } from "../adapters/provider";

/** `workspace` is the Workspace's own `oauth_app:<connection>`, which the vault reads itself. */
export type AppOwner = "workspace" | "platform" | "deployment" | "sign_in";

export type OAuthApp = ClientPair & { owner: AppOwner };

export type AppContext = { workspaceId: string; orgId: string; connection: string };

/**
 * One owner's apps. The vault calls `apps` outside the caller's Workspace transaction, since a
 * source may itself read the vault (the deployment app lives in the system Workspace).
 */
export type AppSource = {
  owner: Exclude<AppOwner, "workspace">;
  /** The apps this source holds for a connection, newest first. A new connect uses the first. */
  apps: (ctx: AppContext) => Promise<OAuthApp[]>;
};

/** A source with at most one app per connection. */
export function singleAppSource(owner: AppSource["owner"], app: (connection: string) => Promise<ClientPair | null>): AppSource {
  return {
    owner,
    apps: async ({ connection }) => {
      const pair = await app(connection);
      return pair ? [{ clientId: pair.clientId, clientSecret: pair.clientSecret, owner }] : [];
    },
  };
}

/** The app a new connect would use: the first app of the first source that has one. */
export async function firstApp(sources: readonly AppSource[], ctx: AppContext): Promise<OAuthApp | null> {
  for (const source of sources) {
    const [app] = await source.apps(ctx);
    // The source, not the app it returns, says who owns it.
    if (app) return { clientId: app.clientId, clientSecret: app.clientSecret, owner: source.owner };
  }
  return null;
}
