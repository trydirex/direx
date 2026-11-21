---
name: advisory-fix
description: Use when a security problem in Direx has been reported privately (a GitHub security advisory or the email in SECURITY.md) or found by a maintainer and is not public yet. Keeps every detail out of public places, reproduces the problem with a failing test, fixes it in the advisory's temporary private fork, runs the full checks locally because CI does not run there, and prepares the patch release and the advisory text for a maintainer to publish. Does NOT open a public PR or issue, merge the fork, request a CVE, publish the advisory or reply to the reporter; a maintainer does those.
---

# Fixing a privately reported security problem

Maintainers only. If you found a problem and aren't a maintainer, report it as `SECURITY.md` says and
stop there.

Until the advisory is published, everything about the problem is secret. Assume anything on the
public repo, including branch names, commit messages, PR titles, CI logs and bot review comments, is
read by someone who will exploit the gap between disclosure and upgrades.

## This replaces the usual PR flow

The fix goes only to the advisory's temporary private fork. Nothing about it reaches
`trydirex/direx` until a maintainer merges it from the advisory page. Keep details out of issues,
discussions, chat and notes too, until publication.

## Steps a maintainer takes

| Step | Why a person does it |
|---|---|
| Reply to the reporter: acknowledge within 7 days (`SECURITY.md` promises that), offer them the fix to review, confirm publication | the advisory thread has no comment API, and it's the project's voice |
| Create the draft advisory, if the report came by email | sets severity and scope for the public record |
| Request the CVE | irreversible, and issued under the project's name |
| Merge the private fork's PR from the advisory page | a merge to `main` |
| Publish the advisory | the moment of disclosure |

Draft the text for each, and keep going with the work that doesn't wait on them.

## 1. Understand the report

```bash
gh api repos/trydirex/direx/security-advisories/<GHSA-ID>
```

Read `description`, `severity`, `cvss` and `vulnerabilities`, and match it to the scope list in
`SECURITY.md`. Write the attack in one paragraph: who the attacker is, what they control and what they
get. Then read the rules for that area in `AGENTS.md` and `CONSTRAINTS.md`: Workspace isolation is
forced row-level security, and nothing reaches the outside world without a person's approval or a
granted rule through the action ledger.

## 2. Get the private fork

On the maintainer's go-ahead:

```bash
gh api --method POST repos/trydirex/direx/security-advisories/<GHSA-ID>/forks --jq '.full_name,.ssh_url'
```

Clone it into its own directory, away from your normal checkout, and use a neutral branch name such
as `fix`, never one that names the bug. GitHub Actions do not run on these forks.

## 3. Reproduce, then fix

1. Write a test that performs the attack as reported and **fails** on current code. Put it next to
   the code it covers, and name it after the behaviour it protects ("refuses a URL that resolves to a
   private address"), not after the attack.
2. Make the smallest fix that closes it. No refactors, no new dependencies unless unavoidable, and no
   schema change that blocks a rollback unless the maintainer agrees.
3. Look for the same kind of problem nearby: other callers of the same fetch helper, other queries
   missing the same Workspace guard, other webhooks with the same check. Fix them in the same patch or
   list them for the maintainer.
4. Keep commit messages generic ("Tighten URL checks in page fetching"). Don't mention the advisory,
   the reporter or the attack.

## 4. Run everything CI would

CI won't run, so run `bun run check:full` and `bun scripts/check-first-run.ts` yourself. If the fix
touches `deploy/`, also run the steps in `.github/workflows/install.yml` by hand. Then push to the
private fork and open the PR there, with `.github/pull_request_template.md` filled in.

## 5. Prepare the release and the advisory

Write these for the maintainer to review:

- **Advisory fields**: affected versions `<= <current tag>`, patched version the next patch (see
  `cut-release`), ecosystem `other` with package `direx` (the image on ghcr). Use ecosystem `npm` and
  `@trydirex/plugin-sdk` instead when the bug is in the SDK. Credit the reporter if they agreed.
- **The Security section of the release notes**: what was wrong in one plain sentence, who is
  affected, "upgrade now", the advisory link and the credit. `release-notes` adds it.
- **The messages to the reporter** for each maintainer step above.

## 6. Publish in one sitting

Keep the gap between the fix becoming visible and the release being available as short as possible:

1. The maintainer requests the CVE, if wanted.
2. The maintainer merges the fork's PR from the advisory page. The commits are now public on `main`.
3. Cut the patch release right away (`cut-release`) and wait for `release-image` to finish.
4. The maintainer publishes the advisory with the patched version filled in.
5. Check: `gh api repos/trydirex/direx/security-advisories/<GHSA-ID> --jq '{state,cve_id,published_at}'`.
   A CVE id can take hours to appear.

## Report

The advisory id, the attack in one paragraph, the fix and the test that proves it, the nearby places
checked, the local check results, the private fork's PR link, and each maintainer step as done or
open, with its drafted text.
