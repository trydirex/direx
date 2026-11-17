// SPDX-License-Identifier: AGPL-3.0-only
// An issue a person sends by hand: on Substack always, and on a list whose tool refused to send on its
// plan. It is written and approved like any Issue, but no plugin runs: once approved it shows the
// issue ready to copy, and a person finishes it with "I sent it".
import type { ItemKind } from "../../items";

export const HANDOFF_KIND = "newsletter_handoff";
export type HandoffPayload = { title: string; previewText?: string; markdown: string; html: string; at: string; tool: string };

/** Approving changes nothing outside Direx; it waits for the person to send it. */
export const handoffKind = (): Record<string, ItemKind> => ({
  [HANDOFF_KIND]: { permission: "item.approve", waitsForPerson: true, apply: async () => ({ ok: true }) },
});

/** Substack has no connection, so its name is ours to give. */
export const SUBSTACK = "Substack";
