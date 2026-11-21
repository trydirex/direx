---
name: pr-green
description: Use when an open Direx pull request has failing or pending checks, unanswered CodeRabbit or reviewer comments, or a description that pr-policy rejects, and the job is to take it to green. Reads every check and comment on the PR's latest commit, sorts them into must-fix, answer-only and already-done, fixes the must-fix items on the PR's own branch, and loops until the latest head is green or one exact blocker is named. Does NOT merge, force-push, push to main, add the constraints-approved label, edit CONSTRAINTS.md or .github/ to make a check pass, or open a new PR.
---

# Taking a PR to green

Finished means one of two things: every required check on the PR's **current head commit** passed
and every review thread is answered, or you can name the one thing blocking it and who has to act.
"Mostly green" is neither.

## Ground rules

- Follow "Pull requests" in `AGENTS.md`. Push only when the person you work for asked for it, only
  to the PR's own branch, and only plain fast-forward pushes. Never force-push, push to `main`,
  merge or close.
- Some checks exist to stop you. `check:floor` is skipped only when a maintainer adds the
  `constraints-approved` label, and `pr-policy` enforces the title, template and size rules. Fix
  the PR, not the check. If the fix would weaken `CONSTRAINTS.md`, touch `.github/` or edit a
  merged migration, stop and ask.
- If the checkout has other uncommitted work, use a worktree on the PR branch
  (`git worktree add ../direx-<slug> <branch>`) so that work stays out of your commits.

## 1. Find the PR and its head

```bash
gh pr view <N> --json number,title,headRefName,headRefOid,baseRefName,state,isDraft,mergeable
```

No number given: `gh pr view` on the current branch. A draft PR, or one whose base isn't `main`
(a stacked PR), is still in scope; note the stack, since a fix may belong in the base PR.

## 2. Pull in the bot's commits first

CodeRabbit's autofix can push commits straight onto the PR branch, sometimes minutes after it opens.

```bash
git fetch origin
git log --oneline <branch>..origin/<branch>
```

Merge anything there before you change a line, and read it: keep sound fixes, revert unsound ones
with a normal commit. For a stacked PR, merge the base branch's new commits up the stack too.

## 3. Read every signal on the current head

```bash
gh pr checks <N>
gh pr view <N> --json statusCheckRollup,reviews,comments,body
gh api --paginate "repos/trydirex/direx/pulls/<N>/comments?per_page=100"   # inline review comments
```

Wait for pending checks (`gh pr checks <N> --watch`) rather than reading half a result. A check,
review or bot summary attached to an older commit is stale and does not count.

| Check | What it runs | Reproduce locally |
|---|---|---|
| `ci` | `bun run ci`, coverage, `check:floor`, `check:web`, `check:security` | `bun run check:full` |
| `first-run` | empty checkout to a signed-in person, on the oldest supported Node | `bun scripts/check-first-run.ts` |
| `install` (only when `deploy/**` changes) | builds the image, runs `deploy/compose/install.sh` twice | the steps in `.github/workflows/install.yml` |
| `pr-policy` | `scripts/check-pr.ts`: title, template sections, size, linked issue | edit the description; the job reruns on `edited` |

For a failing job, read its log, not just its name: `gh run view <run-id> --log-failed`. Reproduce
it before calling it flaky. If the local database runs out of connections under the full suite,
point the `DIREX_DB_*` URLs at a Postgres of your own rather than skipping tests. A test that fails
once and passes on rerun is still a finding: name it in the report.

## 4. Sort what you found

| Kind | Meaning | Action |
|---|---|---|
| **Must fix** | a failing check, a correct review comment, a description section pr-policy rejects | change the code or the description |
| **Answer only** | a question, a suggestion you disagree with, an FYI | reply on the thread with the reason |
| **Already done** | fixed by a later commit, including the bot's | reply naming the commit, then resolve |

Judge each bot comment on its merits. CodeRabbit is often right about missing guards and often
wrong about rules it can't see, such as Workspace isolation, the action ledger or approval checks.
Disagreeing is fine; say why in a sentence or two on the thread.

## 5. Fix, check, push

1. Make the smallest change that resolves each must-fix item.
2. `bun run check:task` must pass before every push. If the description's claims changed, update
   its Verification section with the commands you ran and their results.
3. Stay within 500 changed lines and 10 files (not counting `bun.lock` and
   `packages/db/migrations/meta/`). If a fix would cross that, stop and propose a split.
4. Commit with an imperative message and no `Co-authored-by` for an AI tool, run
   `git fetch origin && git log <branch>..origin/<branch>` once more, then push.

## 6. Answer and resolve threads

Reply on each thread you handled, then resolve only those threads. To list them:

```bash
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{author{login} path body}}}}}}}' -F o=trydirex -F r=direx -F n=<N>
```

Resolve with the `resolveReviewThread` mutation. A person's thread you disagreed with stays open
for them to close.

## 7. Loop

Go back to step 2 after each push: the new head starts with no results, and the bot may have pushed
again. Stop when the head is green and every thread is handled, or after three rounds on the same
failure. At that point name the blocker instead of trying a fourth fix.

## Report

- PR title, link and head SHA
- Each check: passed, failed (with the cause) or not run (path-filtered)
- Threads: fixed, answered, or left open for a person, with links
- The commits you pushed, one line each
- The blocker, if any: what it is, the evidence, and who must act (for example "needs the
  `constraints-approved` label from a maintainer" or "the issue lacks the `accepted` label")
