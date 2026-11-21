---
name: real-eval
description: Use when a Direx agent, draft check or published skill needs a new real-key eval, or an existing one needs new cases, a new purpose or a new model. Covers the *.real.test.ts file and its cases, the scorer and why it must reject a plausible wrong answer, wiring the purpose into scripts/eval.ts, the recorded result file, the route's evalRef and eval:check, and how to read and report a run. Does NOT edit a result file by hand, move a signed bar, point evalRef at a stale result, or commit.
---

# Adding a real-key eval

A real eval runs a Direx model call end to end against a real provider and records whether the
output passed. `bun run eval:check` (in CI, with no key) then refuses any route whose prompt changed
since the result it points at. The result file is evidence, so this skill is about keeping that
evidence honest.

## Where things live

| Piece | Location |
|---|---|
| The eval | `apps/api/src/modules/<module>/<name>.real.test.ts`, most under `agents/`. `vitest.config.ts` leaves every `*.real.test.ts` out unless `DIREX_EVAL_PURPOSE` is set |
| Cases and scorer | the module's `evals.ts`, or `definitions/eval-cases.ts`. `check:deps` lets another module reach them only through `index.ts` or `evals.ts`, and only tests and scripts import `evals.ts` |
| The command | `scripts/eval.ts`: `USAGE`, the `purposes` list, `FILES`, and the `--model` allowlist |
| Recorded results | `apps/api/src/modules/agents/evals/results/<agent>-v<version>-<provider>-<model>.json`, named by `resultFileOf` |
| Pass bars | a named constant in the test, or a maintainer-signed bar in `agents/evals/bars.ts` |
| Routes | `apps/api/src/modules/models/purposes.ts`, where a candidate's `evalRef` names its result |
| Published skills | cases and scorers under `test/skills/` (`run.ts`, `score/`), run with `bun run eval --skill <name>` |

Copy the nearest existing eval rather than inventing a shape. `agents/campaign-writer.real.test.ts`
is a compact example.

## 1. Define the cases

- Feed each case in the exact format production builds, through the real builder function where
  one exists, not a hand-written lookalike. An eval of a different input proves nothing.
- Cover the normal case and the ones that break things in practice: empty or missing data, too
  little data to conclude, conflicting sources, and hostile page text where pages are read.
- Give each case a stable `id` and a one-line comment saying what it tests.
- No real customer data and no real or realistic-looking keys. GitHub push protection blocks fake
  keys that look real, so make fakes obviously fake.

## 2. Score it, and prove the scorer can fail

Score every run with the same check production runs before a person sees the output (for example
`writeUpProblem`), plus schema validity. Where production has no such check, write one in the
module's domain code, not in the test.

Before any paid run, add an ordinary unit test (it runs in `check:task`) showing that the scorer
**rejects a plausible wrong output** for each case and accepts a correct one. A scorer that passes
everything makes every result a pass. Missing output, a refusal or a timeout counts as a failed run,
never as skipped.

## 3. Set the bar

Use a bar that already exists for this kind of output (most drafters allow at most 10% problem runs)
and say which one. A new safety bar, or a changed number in `bars.ts`, needs a maintainer's
signature: propose it and stop. Never pick the bar after seeing the result.

## 4. Wire the command

Add the purpose to `scripts/eval.ts` in all four places, and to the usage comment at the top. With
no token set, `bun run eval --purpose <name> --provider claude_code` should fail asking for the
token, not with a usage error.

## 5. Run it

Export `DIREX_EVAL_CLAUDE_CODE_TOKEN` (or `DIREX_EVAL_ANTHROPIC_KEY` for `--provider anthropic`) in
the shell that runs the eval. Never print it or commit it. Runs cost money or subscription quota, so
do one run of every case first, then the full count the bar asks for:

```bash
bun run eval --purpose <name> --provider claude_code --runs 1
bun run eval --purpose <name> --provider claude_code --runs 5
```

The test writes the result file. Transcripts go to a temp directory; read them, don't commit them.

## 6. Read the failures

Sort every failed run before changing anything:

- **The model got it wrong** on input it should handle: a prompt change. Bump the definition's
  version with it, since the result file is keyed to the version and the prompt digest.
- **Product bug**: the brief, builder or tool gave the model wrong or misleading input. Fix the code.
- **Scorer bug**: it rejected a good answer or passed a bad one. Fix the scorer and its unit test.
- **Infrastructure**: provider error, rate limit, sandbox or timeout. Rerun. If it keeps happening,
  report it as an infrastructure finding, not as a model result.

Never make the gate pass by editing a result file, deleting failed runs, pointing `evalRef` at an
older result or dropping `evalRef` from a route. Each of those weakens `CONSTRAINTS.md`.

## 7. Record and connect

- Commit the result file with the eval. A route's `evalRef` changes only when a passing result
  supports it, in the same PR or the one that adds the route.
- `bun run eval:check` and `bun run check:task` must pass.

## Report (in the PR description)

Under a "Result" heading: the exact command, its duration, passes per case and in total, the model,
the definition version and the start of the prompt digest. Then a "Read by a person" list of problems
the scorer didn't catch, each marked as a follow-up or a blocker. Say plainly if the run was partial
or used fewer runs than the bar asks for.
