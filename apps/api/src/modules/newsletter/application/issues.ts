// SPDX-License-Identifier: AGPL-3.0-only
// Writing an Issue: a person edits its title, preview text and Markdown; Direx renders the HTML into
// the spec. Every edit replaces the spec, so an approval it had is void. Approving goes through the
// items path, which sets the send time to the slot and refuses a slot already gone. A handoff is
// written the same way; once approved, a person sends it by hand and says so.
import type { Items, ItemView } from "../../items";
import { inWorkspace, issueByItem, issuesBefore, recordSent } from "../adapters/repo";
import { renderIssue } from "../domain/render";
import { HANDOFF_KIND } from "./handoff";

type Spec = { title: string; previewText?: string; html: string; markdown?: string; at: string; listId?: string; audience?: unknown; tool?: string };
export type IssueStats = { recipients: number; delivered?: number; clicks: number; unsubscribes: number; opens: number };
/** handoffTo names the tool a person copies a handoff into; null for an issue Direx publishes. */
export type IssueView = { item: ItemView; slot: string; title: string; previewText: string; markdown: string; html: string; handoffTo: string | null; sentAt: string | null; stats: IssueStats | null; statsReadAt: string | null };
/** One row of the issue list: the Item's title and state with what the tool reported. */
export type IssueSummary = { itemId: string; slot: string; title: string; state: ItemView["state"]; reason: string | null; sentAt: string | null; stats: IssueStats | null };
export type IssueInput = { title: string; previewText?: string | undefined; markdown: string };

export function issueDesk(d: { items: () => Pick<Items, "detail" | "view" | "reviseActionItem" | "reviseOwnItem" | "submitItem" | "finishOwnItem">; now?: () => Date }) {
  const now = d.now ?? (() => new Date());
  async function read(workspaceId: string, itemId: string) {
    const issue = await inWorkspace(workspaceId, (tx) => issueByItem(tx, itemId));
    const detail = issue && (await d.items().detail(workspaceId, itemId));
    return issue && detail ? { issue, item: detail.item, spec: detail.content as Spec } : null;
  }
  const view = (r: NonNullable<Awaited<ReturnType<typeof read>>>): IssueView => ({
    item: r.item,
    slot: r.issue.slot.toISOString(),
    title: r.spec.title,
    previewText: r.spec.previewText ?? "",
    markdown: r.spec.markdown ?? "",
    html: r.spec.html,
    handoffTo: r.item.kind === HANDOFF_KIND ? (r.spec.tool ?? null) : null,
    sentAt: r.issue.sentAt?.toISOString() ?? null,
    stats: (r.issue.stats as IssueStats | null) ?? null,
    statsReadAt: r.issue.statsReadAt?.toISOString() ?? null,
  });

  return {
    /** A page of issues, newest slot first. `next` is the slot to pass as `before` for the page after, or null at the end. */
    async list(workspaceId: string, before: Date | null, limit: number): Promise<{ issues: IssueSummary[]; next: string | null }> {
      const rows = await inWorkspace(workspaceId, (tx) => issuesBefore(tx, before, limit + 1));
      const page = rows.slice(0, limit);
      // ponytail: one Item read per row; a page is small. A join through the items module if pages grow.
      const issues: IssueSummary[] = [];
      for (const r of page) {
        const item = await d.items().view(workspaceId, r.itemId);
        if (!item) continue;
        issues.push({ itemId: r.itemId, slot: r.slot.toISOString(), title: item.title, state: item.state, reason: item.reason, sentAt: r.sentAt?.toISOString() ?? null, stats: (r.stats as IssueStats | null) ?? null });
      }
      return { issues, next: rows.length > limit ? page.at(-1)!.slot.toISOString() : null };
    },

    async get(workspaceId: string, itemId: string): Promise<IssueView | null> {
      const r = await read(workspaceId, itemId);
      return r && view(r);
    },

    /** New words for an Issue not yet sent. The slot and the list stay as the weekly job set them; the Item takes the issue's title. */
    async revise(workspaceId: string, itemId: string, input: IssueInput, userId: string) {
      const r = await read(workspaceId, itemId);
      if (!r) return { ok: false, reason: "not_found" } as const;
      const previewText = input.previewText?.trim() || undefined;
      const written = { title: input.title, ...(previewText && { previewText }), html: renderIssue(input.markdown), markdown: input.markdown, at: r.spec.at };
      const revised =
        r.item.kind === HANDOFF_KIND
          ? // A handoff's edit puts it in front of a person again, as any own Item's does.
            await d.items().reviseOwnItem(workspaceId, itemId, {
              payload: { ...written, tool: r.spec.tool },
              actor: { userId },
              details: { title: input.title, workArea: r.item.workArea, channel: r.item.channel, groupKey: r.item.groupKey, groupLabel: r.item.groupLabel, plannedAt: r.issue.slot, warnings: r.item.warnings },
            })
          : await d.items().reviseActionItem(workspaceId, itemId, { spec: { ...written, ...(r.spec.listId && { listId: r.spec.listId }), audience: r.spec.audience }, actor: { userId }, details: { title: input.title, warnings: r.item.warnings } });
      if (!revised.ok) return revised;
      return { ok: true, issue: view((await read(workspaceId, itemId))!) } as const;
    },

    /** Sends a written Issue for approval. An Issue with no title or no body has nothing to approve. */
    async submit(workspaceId: string, itemId: string, userId: string) {
      const r = await read(workspaceId, itemId);
      if (!r) return { ok: false, reason: "not_found" } as const;
      if (!r.spec.title.trim() || !r.spec.html) return { ok: false, reason: "issue_empty" } as const;
      if (r.item.kind === HANDOFF_KIND && r.item.state === "needs_approval") return { ok: true, issue: view(r) } as const;
      const submitted = await d.items().submitItem(workspaceId, itemId, { userId });
      if (!submitted.ok) return submitted;
      return { ok: true, issue: view((await read(workspaceId, itemId))!) } as const;
    },

    /** A person sent an approved handoff by hand. It counts as this week's send. */
    async markSent(workspaceId: string, itemId: string, userId: string) {
      const r = await read(workspaceId, itemId);
      if (!r || r.item.kind !== HANDOFF_KIND) return { ok: false, reason: "not_found" } as const;
      const at = now();
      const done = await d.items().finishOwnItem(workspaceId, itemId, { userId }, (tx) => recordSent(tx, r.issue.id, null, at, at));
      if (!done.ok) return done;
      return { ok: true, issue: view((await read(workspaceId, itemId))!) } as const;
    },
  };
}
export type IssueDesk = ReturnType<typeof issueDesk>;
