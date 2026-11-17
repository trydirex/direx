// SPDX-License-Identifier: AGPL-3.0-only
// Home's replies and opt-outs for the last 7 days, each with the sentence behind it from `result_why`, or none.
// One ask per Workspace per day: the first read of the day fixes the window, and later reads get the same answer.
import { askResultWhy, lineProblems, type WhyResult } from "../../items";
import type { Models } from "../../models/index";
import { inWorkspace } from "../adapters/repo";
import { resultFacts } from "../adapters/results-repo";
import { replyResults } from "../domain/results";

export type ResultLine = { key: string; label: string; now: number; before: number; why: string | null };

const DAY_MS = 86_400_000;
/** How many restarts a day still get a sentence. */
const RESTARTS = 50;

/** The model's line, kept only when Home can show it. */
function lines(results: WhyResult[], answer: { lines: { key: string; why: string | null }[] } | null): ResultLine[] {
  return results.map((r) => {
    const why = answer?.lines.find((l) => l.key === r.key)?.why?.trim() || null;
    return { key: r.key, label: r.label, now: Number(r.now), before: Number(r.before), why: why && lineProblems(why, results).length === 0 ? why : null };
  });
}

export function resultLines(deps: { now: () => Date; generate?: () => Models["generate"] | undefined }) {
  // ponytail: in-process cache, so each restart costs one more model call that day (and past RESTARTS, no sentence).
  // Store the lines in a table if that cost shows up.
  const cache = new Map<string, Promise<ResultLine[]>>();

  async function ask(workspaceId: string, userId: string, to: Date): Promise<ResultLine[]> {
    const results = await inWorkspace(workspaceId, async (tx) => replyResults(await resultFacts(tx, new Date(to.getTime() - 14 * DAY_MS), new Date(to.getTime() - 7 * DAY_MS), to)));
    const generate = deps.generate?.();
    if (results.length === 0 || !generate) return lines(results, null);
    // A repeat is refused, and after a restart the same facts are a repeat, so ask again with one more trailing space,
    // as the eval's runs do. Each refused repeat is a lookup, not a model call. A model that declines once is asked
    // once more, so one odd answer doesn't leave Home without a sentence all day.
    let asked = await askResultWhy(generate, workspaceId, userId, results);
    let declined = false;
    for (let n = 1; n < RESTARTS && "failure" in asked; n++) {
      if (asked.failure !== "duplicate") {
        if (declined || !asked.failure.startsWith("model_refusal")) break;
        declined = true;
      }
      asked = await askResultWhy(generate, workspaceId, userId, results, " ".repeat(n));
    }
    return lines(results, "output" in asked ? asked.output : null);
  }

  return (workspaceId: string, userId: string): Promise<ResultLine[]> => {
    const at = deps.now();
    const day = at.toISOString().slice(0, 10);
    const key = `${workspaceId}:${day}`;
    for (const k of cache.keys()) if (!k.endsWith(day)) cache.delete(k);
    let found = cache.get(key);
    if (!found) {
      found = ask(workspaceId, userId, at);
      cache.set(key, found);
      // A failed read isn't kept, so the next one tries again.
      found.catch(() => cache.delete(key));
    }
    return found;
  };
}
