// SPDX-License-Identifier: AGPL-3.0-only
// Who works at a company, in two steps. After its read is recorded, one names_reader run is started on
// the snapshot text. When the run hands over, its people are kept only if the stored snapshots hold
// their names, and an address no one was known by becomes theirs if it matches.
import { z } from "zod";
import type { Sink } from "../../agents/index";
import { inWorkspace, namesToCheck, recordNames, skipNames } from "../adapters/repo";
import { classify } from "../domain/addresses";
import { keptPeople, namesText, type NamedPerson } from "../domain/people";
import type { PageText } from "../domain/signals";
import { namesReader, type NamesOutput } from "../definitions/names-reader";
import type { OpenReview } from "./review";

/** Starts a run through the agents module, which admits it under its caps. A refusal names why. */
export type StartNames = (workspaceId: string, a: { agent: string; input: NamesInput; startedBy: string }) => Promise<{ ok: true } | { ok: false; reason: string }>;
export type NamesInput = { text: string; companyId: string };

const Input = z.object({ companyId: z.uuid() });

/** Starts the names run for a company just read. A refused start is recorded on the company, not thrown. */
export async function startNames(start: StartNames | undefined, a: { workspaceId: string; companyId: string; domain: string; pages: readonly PageText[]; startedBy: string; now: Date }): Promise<void> {
  const started = start ? await start(a.workspaceId, { agent: namesReader.id, input: { text: namesText(a.domain, a.pages), companyId: a.companyId }, startedBy: a.startedBy }) : { ok: false as const, reason: "no_models" };
  if (!started.ok) await inWorkspace(a.workspaceId, (tx) => skipNames(tx, a.companyId, started.reason, a.now));
}

/**
 * Where a names run's people land. Safe to call twice: a company whose names are done is left as it is.
 * Once the names are settled, the company's review Item is made, and its id is what the run handed over.
 */
export function namesSink(now: () => Date, openReview?: OpenReview): Sink {
  return async (workspaceId, proposal, context) => {
    const input = Input.safeParse(context.input);
    if (!input.success) return { ok: false, code: "no_company" };
    const { companyId } = input.data;
    const reported = (proposal.body as NamesOutput).people;
    const settled = await inWorkspace(workspaceId, async (tx) => {
      const found = await namesToCheck(tx, companyId);
      if (!found) return { ok: false, code: "no_company" } as const;
      if (found.namesStatus === "done") return { ok: true } as const;
      if (found.namesStatus !== "pending") return { ok: false, code: "names_not_pending" } as const;
      const people = keptPeople(reported, found.pages);
      const named = found.unknown.flatMap((a) => {
        const c = classify(a.email, people);
        // classify hands back the person it matched, role and all.
        return c.kind === "named" ? [{ id: a.id, person: c.name as NamedPerson }] : [];
      });
      await recordNames(tx, { workspaceId, companyId, runId: context.runId, people, named, now: now() });
      return { ok: true } as const;
    });
    if (!settled.ok) return settled;
    return { ok: true, itemId: (await openReview?.(workspaceId, companyId)) ?? null };
  };
}

/** A names run that ended without handing names over, whatever stopped it, so its company says why and its review opens. */
export async function namesEnded(run: { workspaceId: string; agent: string; status: string; input: unknown }, now: Date, openReview?: OpenReview): Promise<void> {
  const input = Input.safeParse(run.input);
  if (run.agent !== namesReader.id || !input.success) return;
  await inWorkspace(run.workspaceId, (tx) => skipNames(tx, input.data.companyId, run.status, now));
  await openReview?.(run.workspaceId, input.data.companyId);
}
