// SPDX-License-Identifier: AGPL-3.0-only
// After a prompt change: which revisions to bump and which real-key evals to rerun. It reads
// `eval:check`, whose prompt digests already say which routes changed, so it needs no key and no
// diff of its own. The prompt-change skill's table is the source of the run counts. Exit 0 always.

export type Impact = { bump: string[]; commands: string[]; notes: string[] };

// Runs per purpose, from the prompt-change skill; anything else gets 5.
const RUNS: Record<string, number> = { plan_draft: 3, person_skeleton: 3 };

export function impactOf(gateOutput: string): Impact {
  const bump = new Set<string>();
  const purposes = new Set<string>();
  const commands = new Set<string>();
  const notes = new Set<string>();
  for (const line of gateOutput.split("\n")) {
    const route = /^eval:check: (\S+) v\d+ \((\w+)\) on \S+ \S+: (.*)$/.exec(line);
    if (route) {
      const [, agent, purpose, why] = route;
      if (why!.startsWith("the prompt changed")) bump.add(agent!);
      if (why !== "no eval result") purposes.add(purpose!);
      continue;
    }
    const skill = /^eval:check: skill (\S+): no passing result for its current files on (.*)$/.exec(line);
    if (skill) for (const p of skill[2]!.split(", ")) commands.add(`bun run eval --skill ${skill[1]} --provider ${p.split(" ")[0]}`);
  }
  // Untrusted-text wording sits in the injection check; the hostile pages prove it holds.
  if (purposes.has("injection_check")) purposes.add("hostile_pages");
  for (const p of purposes) {
    if (p === "brand_extract") notes.add("brand_reader: its eval needs an Anthropic API key (bun run eval --agent brand_reader); leave the route unevaluated rather than invent a result");
    else commands.add(`bun run eval --purpose ${p} --provider claude_code --runs ${RUNS[p] ?? 5}`);
  }
  return { bump: [...bump], commands: [...commands], notes: [...notes] };
}

if (import.meta.main) {
  const run = Bun.spawnSync(["bun", "scripts/eval-check.ts"], { stdout: "pipe", stderr: "pipe" });
  const { bump, commands, notes } = impactOf(`${run.stdout}\n${run.stderr}`);
  if (!bump.length && !commands.length && !notes.length) console.log("eval-impact: no route or skill is behind its prompt");
  for (const a of bump) console.log(`bump: ${a} (promptRevision on an agent, version on a check without one)`);
  for (const c of commands) console.log(`run:  ${c}`);
  for (const n of notes) console.log(`note: ${n}`);
  if (run.exitCode !== 0 && !bump.length && !commands.length) console.log("eval-impact: eval:check failed for another reason; run bun run eval:check");
}
