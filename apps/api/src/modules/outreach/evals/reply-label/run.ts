// SPDX-License-Identifier: AGPL-3.0-only
// Eval checkpoints contain validated labels only. Reply text stays in memory.
import { createHash } from "node:crypto";
import { readLabel, type LabelAnswer, type ReplyLabel } from "../../domain/reply-label";
import { scoreLabels, type LabelSet } from "./score";

export function evalSettings(defaultModel: string, env: Record<string, string | undefined>) {
  const runs = Number(env.DIREX_EVAL_RUNS ?? "5");
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("DIREX_EVAL_RUNS must be a positive integer");
  return { model: env.DIREX_EVAL_MODEL || defaultModel, runs };
}

export function progressFileOf(file: string, promptDigest: string, set: LabelSet, runs: number) {
  const digest = createHash("sha256").update(JSON.stringify(set.replies)).digest("hex");
  return `${file}.${promptDigest}.${digest}.${runs}.progress.json`;
}

export async function collectLabels({ set, runs, done, ask, save, report }: {
  set: LabelSet;
  runs: number;
  done: Record<string, ReplyLabel | null>;
  ask: (words: string) => Promise<{ answer: LabelAnswer | null; failure: string | null }>;
  save: (done: Record<string, ReplyLabel | null>) => void;
  report: (line: string) => void;
}) {
  const answers: (LabelAnswer | null)[] = [];
  const replies = [];
  for (let run = 0; run < runs; run++) {
    for (const [i, r] of set.replies.entries()) {
      const key = `${run}:${i}`;
      if (!(key in done)) {
        const asked = await ask(r[1]);
        if (asked.failure === "provider_quota") {
          save(done);
          throw new Error(`usage limit reached after ${Object.keys(done).length} answers; run the same command again later to carry on`);
        }
        const reading = readLabel(asked.answer, r[1]);
        done[key] = reading.label === "unlabelled" ? null : reading.label;
        save(done);
      }
      const label = done[key];
      // Quotes have already been validated; reconstruct with the known fixture quote for scoring only.
      answers.push(label ? { label, quote: r[2] } : null);
      replies.push(r);
      if (r[0] === "interested" && label !== "interested") report(`missed interested reply ${i + 1}, run ${run + 1} (got ${label ?? "no answer"})`);
    }
  }
  return { score: scoreLabels({ ...set, replies }, answers), count: replies.length };
}
