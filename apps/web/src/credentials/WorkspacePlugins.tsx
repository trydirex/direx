// SPDX-License-Identifier: AGPL-3.0-only
// The third-party plugins a Server admin installed, on a Workspace's connections page (ADR 0026 rule
// 002): what each can do and reach, and whether it is on here. Only an Owner turns one on or off.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@astryxdesign/core/Switch";
import type { components } from "../api/schema";
import { inWorkspace } from "../api/query";
import { useAction } from "../components/useAction";
import { HANDED, PluginAsks } from "../identity/ServerPlugins";
import { turnPlugin, workspacePluginsQuery, type WorkspacePlugin } from "./actions";

const MESSAGES: Record<string, string> = {
  forbidden: "Only an Owner can turn a plugin on or off.",
  not_installed: "That plugin was removed from this server. Reload the page.",
};

export function WorkspacePlugins({ workspace }: { workspace: components["schemas"]["MyWorkspace"] }) {
  const plugins = useQuery(workspacePluginsQuery(workspace.id)).data;
  // Hidden while none is installed. A failed read hides it too: the page's own reads already say when Direx can't be reached.
  if (!plugins?.length) return null;
  const owner = workspace.role === "owner";
  return (
    <section aria-label="Third-party plugins" className="flex flex-col gap-4 text-base">
      <h2>Third-party plugins</h2>
      <p className="text-muted-foreground">
        A Server admin installed these on this server. One does nothing here until it is turned on. {HANDED}
      </p>
      {!owner && <p className="text-muted-foreground">An Owner of this Workspace turns a plugin on or off.</p>}
      <ul className="grid items-start gap-3 lg:grid-cols-2">
        {plugins.map((p) => (
          <Plugin key={p.pluginId} workspaceId={workspace.id} plugin={p} owner={owner} />
        ))}
      </ul>
    </section>
  );
}

function Plugin({ workspaceId, plugin, owner }: { workspaceId: string; plugin: WorkspacePlugin; owner: boolean }) {
  const client = useQueryClient();
  const turn = useAction(MESSAGES);
  const keyed = plugin.connections.some((c) => c.auth === "api_key");
  return (
    <li aria-label={plugin.name} className="flex flex-col gap-3 rounded-card border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all font-medium">
          {plugin.name} {plugin.version}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Third-party</span>
      </div>
      <PluginAsks plugin={plugin} />
      <Switch
        label={`Use ${plugin.name} in this Workspace`}
        value={plugin.on}
        isDisabled={!owner || turn.pending}
        onChange={(on) =>
          void turn.run(async () => {
            const code = await turnPlugin(workspaceId, plugin.pluginId, on);
            // Its key connection shows under API keys once it is on, so read the whole Workspace again.
            await client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
            return code;
          })
        }
      />
      {turn.error && <p role="alert" className="text-sm text-destructive">{turn.error}</p>}
      {plugin.on && keyed && <p className="text-sm text-muted-foreground">Connect its key under Advanced: API keys, below.</p>}
    </li>
  );
}
