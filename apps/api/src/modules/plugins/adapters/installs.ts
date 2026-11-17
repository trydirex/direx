// SPDX-License-Identifier: AGPL-3.0-only
// Every SQL statement about installed third-party plugins (ADR 0026): the installed list every
// process loads, the gate each call passes in its own transaction, and the notice that the list
// changed.
import { listen, withSystem, withWorkspace } from "@direx/db";
import { sql } from "drizzle-orm";

export type InstalledPlugin = { pluginId: string; installId: string; manifest: unknown; entrySha256: string; generation: string };

export async function listInstalled(): Promise<InstalledPlugin[]> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select plugin_id, install_id, manifest, entry_sha256, generation from system.installed_plugins()`));
  return rows.map((r) => ({
    pluginId: String(r.plugin_id),
    installId: String(r.install_id),
    manifest: r.manifest,
    entrySha256: String(r.entry_sha256),
    generation: String(r.generation),
  }));
}

/**
 * Why a call to this plugin may not go ahead in this Workspace, or null when it may (rules 002 and
 * 004): it must still be installed with these exact bytes, and turned on here for the install and
 * permissions that exist now. Read fresh every time, never cached.
 */
export async function installGate(workspaceId: string, pluginId: string, entrySha256: string): Promise<string | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const { rows } = await tx.execute(sql`
      select system.plugin_turned_on(${pluginId}) as on,
             (select i.entry_sha256 from system.installed_plugins() i where i.plugin_id = ${pluginId}) as sha`);
    const r = rows[0] as { on: boolean; sha: string | null } | undefined;
    if (!r?.sha) return "it is no longer installed";
    if (r.sha !== entrySha256) return "it was upgraded, and this process hasn't loaded the new version yet";
    if (!r.on) return "it isn't turned on in this Workspace";
    return null;
  });
}

/** Calls onChange each time an install, upgrade or removal is made anywhere on this server. */
export const listenForInstalls = (onChange: () => void) => listen("plugins", () => onChange());

export type WorkspacePlugin = { pluginId: string; version: string; manifest: unknown; on: boolean };

/** Every installed plugin, and whether this Workspace has it on for the install and permissions that exist now. */
export function workspacePlugins(workspaceId: string): Promise<WorkspacePlugin[]> {
  return withWorkspace(workspaceId, async (tx) => {
    const { rows } = await tx.execute(sql`
      select i.plugin_id, i.version, i.manifest,
             coalesce(w.install_id = i.install_id and w.permission_hash = i.permission_hash, false) as on
      from system.installed_plugins() i
      left join workspace_plugins w on w.plugin_id = i.plugin_id
      order by i.plugin_id`);
    return rows.map((r) => ({ pluginId: String(r.plugin_id), version: String(r.version), manifest: r.manifest, on: r.on === true }));
  });
}

/** A Workspace owner's yes or no; the yes is bound to the install and permissions that exist now. */
export function setTurnedOn(workspaceId: string, pluginId: string, userId: string, on: boolean): Promise<"not_installed" | null> {
  return withWorkspace(workspaceId, async (tx) => {
    if (!on) {
      await tx.execute(sql`delete from workspace_plugins where plugin_id = ${pluginId}`);
      return null;
    }
    const { rows } = await tx.execute(sql`
      insert into workspace_plugins (workspace_id, plugin_id, install_id, permission_hash, enabled_by, enabled_at)
      select ${workspaceId}::uuid, i.plugin_id, i.install_id, i.permission_hash, ${userId}::uuid, now()
      from system.installed_plugins() i where i.plugin_id = ${pluginId}
      on conflict (workspace_id, plugin_id) do update
        set install_id = excluded.install_id, permission_hash = excluded.permission_hash, enabled_by = excluded.enabled_by, enabled_at = excluded.enabled_at
      returning plugin_id`);
    return rows.length ? null : "not_installed";
  });
}

const pgCode = (e: unknown): string | undefined => {
  for (let x: unknown = e; x; x = (x as { cause?: unknown }).cause) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
};

export type AdminRefusal = "forbidden" | "already_installed" | "not_installed";

/** A Server admin's install or upgrade, through the web (ADR 0026 rule 001). */
export async function installAsAdmin(
  actor: string,
  mode: "install" | "upgrade",
  p: { pluginId: string; version: string; manifest: unknown; permissionHash: string; entrySha256: string },
): Promise<AdminRefusal | null> {
  try {
    await withSystem((tx) =>
      tx.execute(sql`select system.install_plugin(${actor}::uuid, ${mode}, ${p.pluginId}, ${p.version}, ${JSON.stringify(p.manifest)}::jsonb, ${p.permissionHash}, ${p.entrySha256})`),
    );
    return null;
  } catch (e) {
    const code = pgCode(e);
    if (code === "DX403") return "forbidden";
    if (code === "DXINS") return "already_installed";
    if (code === "DX404") return "not_installed";
    throw e;
  }
}

/** A Server admin's removal, through the web. */
export async function removeAsAdmin(actor: string, pluginId: string): Promise<AdminRefusal | null> {
  try {
    await withSystem((tx) => tx.execute(sql`select system.remove_plugin(${actor}::uuid, ${pluginId})`));
    return null;
  } catch (e) {
    const code = pgCode(e);
    if (code === "DX403") return "forbidden";
    if (code === "DX404") return "not_installed";
    throw e;
  }
}
