// SPDX-License-Identifier: AGPL-3.0-only
// Connected network accounts: which networks a Workspace can use, what it has connected, whether each
// still works, and what each can do. Connecting changes nothing on a network, so no Action is involved.
import type { SocialAvailability, SocialNetworkInfo } from "../domain/network";
import type { Identity, Vault } from "../../credentials/index";
import type { Plugins } from "../../plugins/index";
import { accountAbout, accountsOn, deleteTargets, insertTargets, inWorkspace, listAccounts, setAbout, targetIds, touchChecked } from "../adapters/repo";
import { atFloor } from "../domain/budget";
import { canDo, expiryWarning } from "../domain/can-do";
import { healthLine, startHealth, stepUpCredential } from "./account-health";
import { targetsOf } from "./identity";

export type SocialDeps = {
  plugins: () => Pick<Plugins, "socialFor" | "socialConnections" | "identifySocial" | "query">;
  vault: () => Pick<Vault, "appSource" | "create" | "find" | "list" | "markNeedsReauth" | "remove" | "rotate">;
  networks: () => readonly SocialNetworkInfo[];
  deployment: () => "cloud" | "self_host";
  /** The fixed OAuth redirect, shown in the wizard. */
  callbackUrl: () => string;
  now?: () => Date;
};

export function createSocial(deps: SocialDeps) {
  const now = deps.now ?? (() => new Date());
  const network = (connection: string) => deps.networks().find((n) => n.connection === connection);

  /** A token just granted, asked of its plugin, for the connect flow. */
  async function identify(workspaceId: string, connection: string, accessToken: string): Promise<Identity> {
    const { accountId, accountLabel, scopes, grantExpiresAt } = await deps.plugins().identifySocial(workspaceId, connection, { accessToken, expiresAt: now().toISOString() });
    return { accountId, accountLabel, ...(scopes ? { scopes } : {}), ...(grantExpiresAt ? { grantExpiresAt } : {}) };
  }

  async function storedIdentity(workspaceId: string, credentialId: string, connection: string) {
    const provider = deps.plugins().socialFor(connection);
    if (!provider) return null;
    return deps.plugins().query(workspaceId, provider.identity, null, credentialId);
  }

  return {
    identify,

    /**
     * A network with a form rather than OAuth. The typed sign-in goes to one call before anything is stored,
     * so a refusal stores nothing. Connecting the same account again replaces its password.
     */
    async connectForm(workspaceId: string, actorUserId: string, connection: string, input: { username: string; password: string }) {
      const n = network(connection);
      const offered = n && n.connect === "form" && n.availability[deps.deployment()] !== "not_built" && n.availability[deps.deployment()] !== "not_available";
      if (!offered) return { ok: false as const, reason: "unknown_connection" as const };
      let accountId: string;
      let accountLabel: string;
      try {
        ({ accountId, accountLabel } = await deps.plugins().identifySocial(workspaceId, connection, input));
      } catch (e) {
        return { ok: false as const, reason: "sign_in_failed" as const, detail: (e as Error).message };
      }
      const key = `${connection}:${accountId}`;
      const existing = (await deps.vault().list(workspaceId)).find((c) => c.key === key && c.ownerUserId === actorUserId);
      const r = existing
        ? await deps.vault().rotate({ workspaceId, id: existing.id, version: existing.version, value: { password: input.password }, actorUserId })
        : await deps.vault().create({ workspaceId, actorUserId, scope: "user", kind: "basic", connection, key, name: accountLabel, meta: { username: input.username }, value: { password: input.password } });
      return r.ok ? { ok: true as const, credentialId: r.credential.id } : { ok: false as const, reason: "not_saved" as const, detail: r.reason };
    },

    /** The login's owner, null for a Workspace login, undefined if there is none. */
    async ownerOf(workspaceId: string, credentialId: string) {
      return (await deps.vault().find(workspaceId, credentialId))?.ownerUserId;
    },

    /** Every network, with what this deployment and Workspace can do about it. */
    async networks(workspaceId: string) {
      const deployment = deps.deployment();
      return Promise.all(
        deps.networks().map(async (n) => {
          const form = n.connect === "form";
          const built = n.availability[deployment] !== "not_built" && n.availability[deployment] !== "not_available";
          const app = built && !form ? await deps.vault().appSource(workspaceId, n.connection) : null;
          // A self-hoster with no app registers one; on cloud there is nothing they can do.
          const availability: SocialAvailability = built && !form && !app && deployment === "cloud" ? "not_available" : n.availability[deployment];
          const needsWizard = built && !form && !app && deployment === "self_host";
          return {
            connection: n.connection,
            label: n.label,
            accountTypes: [...n.accountTypes],
            connect: n.connect,
            availability,
            canConnect: built && (form || !!app),
            publishes: !!deps.plugins().socialFor(n.connection)?.publish && !!n.features.find((f) => f.key === "publish")?.built,
            app,
            fields: n.fields?.map((f) => ({ ...f })),
            wizard: needsWizard && n.wizard ? { ...n.wizard, scopes: [...n.wizard.scopes], steps: [...n.wizard.steps], callbackUrl: deps.callbackUrl() } : undefined,
          };
        }),
      );
    },

    async accounts(workspaceId: string) {
      const rows = await inWorkspace(workspaceId, listAccounts);
      const at = now();
      const onNetwork = (connection: string) => rows.filter((r) => r.connection === connection).length;
      return Promise.all(
        rows.map(async (r) => {
          const n = network(r.connection);
          const meta = r.meta as { scopes?: string[]; grantExpiresAt?: string };
          const own = (await deps.vault().appSource(workspaceId, r.connection)) === "own";
          const endsAt = n?.tokenEnds ? r.expiresAt : meta.grantExpiresAt ? new Date(meta.grantExpiresAt) : null;
          const health = await healthLine(workspaceId, { credentialId: r.credentialId, networkId: r.networkId }, at);
          return {
            id: r.id,
            credentialId: r.credentialId,
            connection: r.connection,
            network: n?.label ?? r.connection,
            accountType: r.accountType,
            networkId: r.networkId,
            name: r.name,
            status: r.status,
            ownerUserId: r.ownerUserId,
            lastCheckedAt: r.lastCheckedAt,
            warning: expiryWarning(endsAt, at),
            canDo: (n?.features ?? []).map((f) => ({ feature: f.key, status: canDo(f, meta.scopes ?? [], own) })),
            health,
            runBy: r.runBy,
            angle: r.angle,
            // Other accounts on the same network here: Run by and Angle only matter when there are some.
            siblings: onNetwork(r.connection) - 1,
            asksAngle: !!n?.angleForEachAccount,
            establishable: atFloor(health.budget) && !health.paused,
          };
        }),
      );
    },

    /**
     * What a login can post to, marking what is already added. Nothing is added here, even a login's
     * only target: a person picks it, which is also how a login made through a connect link is confirmed.
     */
    async targets(workspaceId: string, credentialId: string) {
      const c = await deps.vault().find(workspaceId, credentialId);
      if (!c?.connection || !network(c.connection)) return null;
      const identity = await storedIdentity(workspaceId, credentialId, c.connection);
      if (!identity) return null;
      const connection = c.connection;
      const [ids, onNetwork] = await inWorkspace(workspaceId, async (tx) => [await targetIds(tx, credentialId), await accountsOn(tx, connection)] as const);
      const added = new Set(ids);
      // Asked before adding, so the picker can ask for the angle instead of failing on it.
      const needsAngle = !!network(connection)?.angleForEachAccount && onNetwork >= 1;
      return targetsOf(identity).map((t) => ({ ...t, added: added.has(t.id), needsAngle: needsAngle && !added.has(t.id) }));
    },

    /**
     * Only what the network says this login can reach can be added. Each new account starts its budget
     * at the floor, or higher when a person says it is established. On a network that allows several
     * accounts only for different purposes, every account after the first needs its angle.
     */
    async addTargets(
      workspaceId: string,
      credentialId: string,
      ids: readonly string[],
      about: { established?: readonly string[]; angles?: Readonly<Record<string, string>> } = {},
    ): Promise<{ ok: true } | { ok: false; reason: "not_a_network_login" | "unknown_target" | "angle_required" }> {
      const c = await deps.vault().find(workspaceId, credentialId);
      const n = c?.connection ? network(c.connection) : undefined;
      if (!c?.connection || !n) return { ok: false, reason: "not_a_network_login" };
      const connection = c.connection;
      const identity = await storedIdentity(workspaceId, credentialId, connection);
      if (!identity) return { ok: false, reason: "not_a_network_login" };
      const all = targetsOf(identity);
      if (ids.some((id) => !all.some((t) => t.id === id))) return { ok: false, reason: "unknown_target" };
      const angleOf = (id: string) => about.angles?.[id]?.trim() || null;
      return inWorkspace(workspaceId, async (tx) => {
        const already = new Set(await targetIds(tx, credentialId));
        const fresh = all.filter((t) => ids.includes(t.id) && !already.has(t.id));
        const before = await accountsOn(tx, connection);
        if (n.angleForEachAccount && fresh.some((t, i) => before + i >= 1 && !angleOf(t.id))) return { ok: false as const, reason: "angle_required" as const };
        await insertTargets(tx, workspaceId, credentialId, connection, fresh.map((t) => ({ ...t, angle: angleOf(t.id) })), now());
        for (const t of fresh) await startHealth(tx, workspaceId, { credentialId, networkId: t.id }, about.established?.includes(t.id) ?? false, now());
        return { ok: true as const };
      });
    },

    /** Who the account itself says runs it, and what it is for. Where angles are needed, one once set can be changed but not removed. */
    async about(workspaceId: string, accountId: string, next: { runBy: string | null; angle: string | null }): Promise<{ ok: true } | { ok: false; reason: "not_found" | "angle_required" }> {
      const clean = (s: string | null) => s?.trim() || null;
      return inWorkspace(workspaceId, async (tx) => {
        const a = await accountAbout(tx, accountId);
        if (!a) return { ok: false as const, reason: "not_found" as const };
        const angle = clean(next.angle);
        if (!angle && a.angle && network(a.connection)?.angleForEachAccount && (await accountsOn(tx, a.connection)) > 1) return { ok: false as const, reason: "angle_required" as const };
        await setAbout(tx, accountId, { runBy: clean(next.runBy), angle });
        return { ok: true as const };
      });
    },

    /** Revokes where the network allows it, and removes the targets. The credential's history stays. */
    async disconnect(workspaceId: string, credentialId: string, actorUserId: string, stepUp: boolean) {
      // This route removes network logins only. Any other secret has its own route and rules.
      const c = await deps.vault().find(workspaceId, credentialId);
      if (!c?.connection || !network(c.connection)) return { ok: false as const, reason: "not_a_network_login" as const };
      const r = await deps.vault().remove({ workspaceId, id: credentialId, actorUserId, stepUp });
      if (!r.ok) return r;
      await inWorkspace(workspaceId, (tx) => deleteTargets(tx, credentialId));
      return { ok: true as const };
    },

    /** Only a network's own refusal asks for a reconnect. Anything else records the time and changes nothing. */
    async checkHealth(workspaceId: string, credentialId: string, connection: string) {
      const provider = deps.plugins().socialFor(connection);
      if (!provider) return;
      let refused = false;
      try {
        const health = await deps.plugins().query(workspaceId, provider.health, null, credentialId);
        refused = !health.ok && health.reason === "auth";
      } catch {
        refused = false;
      }
      if (refused) await deps.vault().markNeedsReauth(workspaceId, credentialId);
      await inWorkspace(workspaceId, (tx) => touchChecked(tx, credentialId, now()));
    },

    /** The daily sweep. Also what renews a self-renewing token on an account nobody posts from. */
    async sweep(credentials: readonly { workspaceId: string; credentialId: string; connection: string }[]) {
      for (const c of credentials) {
        await stepUpCredential(c.workspaceId, c.credentialId, now());
        if (network(c.connection)?.noDailyHealth) continue;
        await this.checkHealth(c.workspaceId, c.credentialId, c.connection);
      }
    },
  };
}
export type Social = ReturnType<typeof createSocial>;
