// SPDX-License-Identifier: AGPL-3.0-only
// How a reply signal searches the Workspace's connected Mailboxes for mail from its sender (ADR 0027 rule
// 001: wiring built in compose, logic here where a test reaches it).
import type { Vault } from "../modules/credentials/index";
import { mailboxNeedsReconnect, type createReplies } from "../modules/outreach/index";
import type { skipFor } from "../modules/placement/index";
import { receivedMail, type Plugins } from "../modules/plugins/index";

type Search = NonNullable<Parameters<typeof createReplies>[0]["searchMailboxes"]>;

export function mailboxSearch(d: {
  /** Read when a search runs: the worker loads plugins after building replies. */
  plugins: () => Pick<Plugins, "mailboxConnections" | "mailboxFor" | "query"> | undefined;
  vault?: Pick<Vault, "markNeedsReauth" | "list">;
  connected: (connections: string[]) => Promise<{ workspaceId: string; credentialId: string; connection: string }[]>;
  /** The Placement checks this Mailbox expects, which a search never fetches. */
  skipFor: typeof skipFor;
  now?: () => Date;
}): Search {
  const now = d.now ?? (() => new Date());
  return async (workspaceId, email) => {
    const plugins = d.plugins();
    if (!plugins) return { events: [], complete: true };
    const found: Awaited<ReturnType<Search>>["events"] = [];
    let complete = true;
    for (const m of await d.connected(plugins.mailboxConnections())) {
      const provider = plugins.mailboxFor(m.connection);
      if (m.workspaceId !== workspaceId || !provider) continue;
      try {
        // Placement checks this Mailbox expects are never fetched, even from a member just added as a Person.
        const skip = await d.skipFor(workspaceId, m.credentialId, now());
        const { events } = await plugins.query(workspaceId, provider.mailFrom, { email, ...(skip.length ? { skip } : {}) }, m.credentialId);
        // Found mail is received mail: parsed as the poll's is, and a search with any that doesn't fit fails.
        found.push(...receivedMail(events).map((e) => ({ ...e, workspaceId, credentialId: m.credentialId })));
      } catch (e) {
        if (!mailboxNeedsReconnect(e)) throw e;
        // One reconnect fixes every search waiting on this Mailbox, and the person sees it as "Reconnect needed".
        await d.vault?.markNeedsReauth(workspaceId, m.credentialId);
        complete = false;
      }
    }
    // A Mailbox already waiting for a reconnect wasn't searched either.
    const waiting = d.vault && (await d.vault.list(workspaceId)).some((c) => c.status === "needs_reauth" && plugins.mailboxFor(c.connection));
    return { events: found, complete: complete && !waiting };
  };
}
