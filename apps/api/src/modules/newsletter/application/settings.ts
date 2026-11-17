// SPDX-License-Identifier: AGPL-3.0-only
// Which list a Workspace's weekly issue goes to, and when. A connected list must be an active
// newsletter key of this Workspace; Substack has no connection and is always copied by hand. A tool
// whose account holds several lists, such as Mailchimp, also needs one of them chosen, kept on the key.
import { clearReadOnly, inWorkspace, readSettings, saveSettings, type SettingsRow } from "../adapters/repo";
import { gapWarning, nextSlot } from "../domain/slots";

type Credential = { id: string; connection: string | null; status: string; scope: string; meta?: unknown };
export type AccountList = { id: string; name: string; subscriberCount: number };

export type NewsletterDeps = {
  /** The Workspace's credentials, as the vault lists them. */
  credentials: (workspaceId: string) => Promise<readonly Credential[]>;
  /** The connections that are newsletter lists, such as "kit" and "beehiiv". */
  lists: () => readonly string[];
  /** A list connection's name as its plugin gives it, such as "Kit". */
  listName?: (connection: string) => string;
  /** Whether the connection's account can hold several lists, so one must be chosen. */
  hasLists?: (connection: string) => boolean;
  /** The lists in the account behind a key, as the tool names them. */
  listsOf?: (workspaceId: string, credentialId: string, connection: string) => Promise<readonly AccountList[]>;
  /** How many people are on the list behind a key, read from the tool now; `listId` names one of several. */
  profileOf?: (workspaceId: string, credentialId: string, connection: string, listId?: string) => Promise<{ subscriberCount: number }>;
  /** Saves one plain field on a key, as the vault does. */
  setMeta?: (workspaceId: string, credentialId: string, name: string, value: string) => Promise<{ ok: boolean }>;
  now?: () => Date;
};

export type SettingsInput = { list: "connected" | "substack"; credentialId: string | null; weekday: number; sendTime: string; timeZone: string; enabled: boolean };
export type SettingsRefusal = "list_not_connected" | "bad_time_zone";
export type ListRefusal = "list_not_connected" | "no_lists" | "not_listed" | "tool_unreachable";

const view = (r: SettingsRow) => ({
  list: r.list as "connected" | "substack",
  credentialId: r.credentialId,
  weekday: r.weekday,
  sendTime: r.sendTime,
  timeZone: r.timeZone,
  enabled: r.enabled,
  readOnlySince: r.readOnlySince?.toISOString() ?? null,
  /** What the tool needs before it sends through Direx, such as "beehiiv Pro". */
  readOnlyReason: r.readOnlyReason,
  lastSentAt: r.lastSentAt?.toISOString() ?? null,
});
export type SettingsView = ReturnType<typeof view>;

/** The list chosen on a key, or nulls before a choice. */
export const chosenList = (c: Pick<Credential, "meta"> | undefined) => {
  const m = (c?.meta ?? {}) as { listId?: unknown; listName?: unknown };
  return { listId: typeof m.listId === "string" ? m.listId : null, listName: typeof m.listName === "string" ? m.listName : null };
};

const knownZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

export function createNewsletter(deps: NewsletterDeps) {
  const now = deps.now ?? (() => new Date());
  const hasLists = (connection: string) => deps.hasLists?.(connection) ?? false;
  const usable = (c: Credential) => c.status === "active" && c.scope === "workspace" && !!c.connection && deps.lists().includes(c.connection);
  const usableKey = async (workspaceId: string, credentialId: string | null) => (await deps.credentials(workspaceId)).find((c) => c.id === credentialId && usable(c));

  async function lists(workspaceId: string, credentialId: string): Promise<{ ok: true; lists: readonly AccountList[] } | { ok: false; reason: ListRefusal }> {
    const key = await usableKey(workspaceId, credentialId);
    if (!key) return { ok: false, reason: "list_not_connected" };
    if (!hasLists(key.connection!) || !deps.listsOf) return { ok: false, reason: "no_lists" };
    try {
      return { ok: true, lists: await deps.listsOf(workspaceId, credentialId, key.connection!) };
    } catch (e) {
      console.error(`newsletter: couldn't read the lists behind key ${credentialId}: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, reason: "tool_unreachable" };
    }
  }

  // A count the page can do without: null when there is no key or chosen list, or the tool can't be read.
  async function subscriberCount(workspaceId: string, key: Credential | undefined): Promise<number | null> {
    const { listId } = chosenList(key);
    if (!key || !deps.profileOf || (hasLists(key.connection!) && !listId)) return null;
    try {
      return (await deps.profileOf(workspaceId, key.id, key.connection!, listId ?? undefined)).subscriberCount;
    } catch (e) {
      console.error(`newsletter: couldn't read the subscriber count behind key ${key.id}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  // ponytail: two writes, id then name; a failure between them leaves the old name beside the new id. One call if that matters.
  async function save(workspaceId: string, credentialId: string, l: AccountList) {
    if (!deps.setMeta) return false;
    return (await deps.setMeta(workspaceId, credentialId, "listId", l.id)).ok && (await deps.setMeta(workspaceId, credentialId, "listName", l.name)).ok;
  }

  return {
    async settings(workspaceId: string): Promise<SettingsView | null> {
      const row = await inWorkspace(workspaceId, readSettings);
      return row ? view(row) : null;
    },

    /**
     * What the settings page shows besides the settings: every newsletter platform with its key when
     * one is connected, the connected lists a person can pick, when the next issue goes out, whether
     * it has been quiet long enough to warn, and how many people the list the issue goes to has.
     */
    async page(workspaceId: string) {
      const row = await inWorkspace(workspaceId, readSettings);
      const keys = (await deps.credentials(workspaceId)).filter(usable);
      const name = (connection: string) => deps.listName?.(connection) ?? connection;
      const lists = keys.map((c) => ({ credentialId: c.id, connection: c.connection!, name: name(c.connection!) }));
      const platforms = deps.lists().map((connection) => {
        // The key the newsletter uses comes first, when a Workspace has more than one for this tool.
        const key = keys.find((c) => c.connection === connection && c.id === row?.credentialId) ?? keys.find((c) => c.connection === connection);
        return { connection, name: name(connection), credentialId: key?.id ?? null, hasLists: hasLists(connection), ...chosenList(key) };
      });
      const at = now();
      return {
        settings: row ? view(row) : null,
        platforms,
        lists,
        nextSlot: row?.enabled ? nextSlot(row, at).toISOString() : null,
        quiet: row ? gapWarning(row.lastSentAt, at) : false,
        // ponytail: read live on each load; cache it on the key if the tool's rate limit starts to bite.
        subscriberCount: row?.list === "connected" ? await subscriberCount(workspaceId, keys.find((c) => c.id === row.credentialId)) : null,
      };
    },

    async saveSettings(workspaceId: string, s: SettingsInput): Promise<{ ok: true; settings: SettingsView } | { ok: false; reason: SettingsRefusal }> {
      if (!knownZone(s.timeZone)) return { ok: false, reason: "bad_time_zone" };
      const key = s.list === "connected" ? await usableKey(workspaceId, s.credentialId) : undefined;
      if (s.list === "connected" && !key) return { ok: false, reason: "list_not_connected" };
      const row = await inWorkspace(workspaceId, (tx) => saveSettings(tx, workspaceId, { ...s, credentialId: s.list === "substack" ? null : s.credentialId }, now()));
      // An account with only one list needs no choice, so it is made here.
      if (key && hasLists(key.connection!) && !chosenList(key).listId) {
        const found = await lists(workspaceId, key.id);
        if (found.ok && found.lists.length === 1) await save(workspaceId, key.id, found.lists[0]!);
      }
      return { ok: true, settings: view(row) };
    },

    lists,

    /** Saves which of the account's lists gets the newsletter. It must be one the tool lists now. */
    async chooseList(workspaceId: string, credentialId: string, listId: string): Promise<{ ok: true; list: AccountList } | { ok: false; reason: ListRefusal }> {
      const found = await lists(workspaceId, credentialId);
      if (!found.ok) return found;
      const list = found.lists.find((l) => l.id === listId);
      if (!list) return { ok: false, reason: "not_listed" };
      return (await save(workspaceId, credentialId, list)) ? { ok: true, list } : { ok: false, reason: "list_not_connected" };
    },

    /** A key was connected or replaced. If it is this list's, the list tries sending again. */
    clearReadOnly: (workspaceId: string, credentialId: string) => inWorkspace(workspaceId, (tx) => clearReadOnly(tx, credentialId, now())),
  };
}
export type Newsletter = ReturnType<typeof createNewsletter>;
