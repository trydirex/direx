// SPDX-License-Identifier: AGPL-3.0-only
// The change classifier's ends in the database: what a run is given (the Changes still unlabelled and
// the answers they may be sightings of, both from the last 4 weeks), starting that run after the weekly
// read, and storing what it answers. The gate is the agent's route: `competitor_change` has none until
// its eval passes the founder's signed bar, so until then a start is refused with no_route.
import type { Sink } from "../../agents/index";
import { answersSince, inWorkspace, labelledByRun, unlabelledSince, writeLabels } from "../adapters/repo";
import type { Source } from "../domain/competitor";
import type { ChangeDetail } from "../domain/diff";
import { labelInput, labelsProblem, type ChangeForLabel, type EarlierAnswer, type LabelOut } from "../domain/labels";
import { changeClassifier, type LabelsOutput } from "../definitions/change-classifier";
import type { Moves } from "./moves";
import { CHANGES_SHOWN_DAYS } from "./snapshots";

const DAY_MS = 86_400_000;

export type Pending = { changes: ChangeForLabel[]; earlier: EarlierAnswer[] };
export type Stored = { ok: true; written: number } | { ok: false; reason: string };
/** A run's input: the untrusted text, and the time it was cut, so the sink checks against the same Changes. */
export type LabelInput = { text: string; asOf: string };
export type StartLabels = (workspaceId: string, a: { agent: string; input: LabelInput; schedule: true }) => Promise<{ ok: true; run: { id: string } } | { ok: false; reason: string }>;

export function createLabels(deps: { now?: () => Date; start?: () => StartLabels; moves?: () => Pick<Moves, "make"> } = {}) {
  const now = deps.now ?? (() => new Date());
  const since = (asOf: Date) => new Date(asOf.getTime() - CHANGES_SHOWN_DAYS * DAY_MS);

  /** What a run starting at `asOf` is given: Changes created after it wait for the next run. */
  async function pending(workspaceId: string, asOf = now()): Promise<Pending> {
    return inWorkspace(workspaceId, async (tx) => {
      const changes = (await unlabelledSince(tx, since(asOf))).filter((c) => c.at <= asOf);
      const earlier = await answersSince(tx, since(asOf));
      return {
        changes: changes.map((c) => ({ ...c, source: c.source as Source, detail: c.detail as ChangeDetail })),
        earlier: earlier.map((a) => ({ ...a, source: a.source as Source, kind: a.kind!, reason: a.reason! })),
      };
    });
  }

  /** Stores a run's labels if they fit what it was given at `asOf`; otherwise nothing, and why. */
  async function store(workspaceId: string, runId: string | null, asOf: Date, labels: LabelOut[]): Promise<Stored> {
    const given = await pending(workspaceId, asOf);
    const problem = labelsProblem(labels, given.changes, given.earlier);
    if (problem) return { ok: false, reason: problem };
    const written = await inWorkspace(workspaceId, (tx) => writeLabels(tx, runId, labels, now()));
    // Counter-moves follow the labels. A failure keeps the labels; the next run makes what's missing.
    if (written > 0) await deps.moves?.().make(workspaceId).catch((e: unknown) => console.error(`counter-moves: workspace ${workspaceId}:`, e));
    return { ok: true, written };
  }

  return {
    pending,
    store,
    /**
     * After the weekly read: one run for the Workspace's unlabelled Changes, or none when there are
     * none. A refused start (no route until the eval passes, the agent turned off) leaves them for next week.
     */
    async classify(workspaceId: string): Promise<{ started: string } | { skipped: string }> {
      const asOf = now();
      const { changes, earlier } = await pending(workspaceId, asOf);
      if (changes.length === 0) return { skipped: "nothing_new" };
      if (!deps.start) return { skipped: "no_agents" };
      const r = await deps.start()(workspaceId, { agent: changeClassifier.id, input: { text: labelInput(changes, earlier), asOf: asOf.toISOString() }, schedule: true });
      return r.ok ? { started: r.run.id } : { skipped: r.reason };
    },
    /** The classifier's sink. Safe to call twice: a run whose labels are already stored is done. */
    sink: (async (workspaceId, proposal, context) => {
      const input = context.input as Partial<LabelInput> | null;
      if (!input?.asOf) return { ok: false, code: "no_input" };
      if ((await inWorkspace(workspaceId, (tx) => labelledByRun(tx, context.runId))) > 0) return { ok: true, itemId: null };
      const r = await store(workspaceId, context.runId, new Date(input.asOf), (proposal.body as LabelsOutput).labels);
      return r.ok ? { ok: true, itemId: null } : { ok: false, code: `labels_refused: ${r.reason}`.slice(0, 400) };
    }) satisfies Sink,
  };
}
export type Labels = ReturnType<typeof createLabels>;
