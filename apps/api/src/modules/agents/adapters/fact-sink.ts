// SPDX-License-Identifier: AGPL-3.0-only
// Hands a fact proposal to facts. A website fact must name a page this run really read, so the
// model can't invent a source, or a run that read nothing can't make a clean Item.
import type { Confidence, Facts, Field, Source } from "../../facts";
import type { Sink } from "../application/proposals";

export type FactBody = { field: Exclude<Field, "never_say" | "competitor">; subject?: string; value: string; confidence: Confidence; page?: string };

/** What Brand already says, for a run's context. */
export const factContext = (facts: Pick<Facts, "usableFacts">) => async (workspaceId: string) =>
  (await facts.usableFacts(workspaceId)).map((f) => ({ id: f.id, version: f.version, text: `${f.field}${f.subject ? ` (${f.subject})` : ""}: ${f.value}` }));

export function factSink(facts: Pick<Facts, "propose">): Sink {
  return async (workspaceId, proposal, context) => {
    const f = proposal.body as FactBody;
    let source: Source = { kind: "document", label: "Pasted text" };
    if ((context.input as { url?: string }).url !== undefined) {
      const page = context.pagesRead.find((p) => p.url === f.page);
      if (!page) return { ok: false, code: "source_not_read" };
      source = { kind: "website", label: page.url, url: page.url, retrievedAt: page.at.toISOString() };
    }
    const r = await facts.propose(workspaceId, {
      field: f.field,
      subject: f.subject,
      value: f.value,
      source,
      confidence: f.confidence,
      untrustedInput: context.tainted,
      actor: { agentRunId: context.runId },
    });
    if (!r.ok) return { ok: false, code: r.reason };
    return r.item ? { ok: true, itemId: r.item.id } : { ok: false, code: "already_in_brand" };
  };
}
