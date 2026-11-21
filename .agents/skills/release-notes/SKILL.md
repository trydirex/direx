---
name: release-notes
description: Use when a Direx release needs its notes, before the tag is pushed or to rewrite the notes of a GitHub Release that already exists. Reads the merged PRs between the last release tag and the chosen commit, finds anything a self-hoster or plugin author must act on (migrations with backfills, install or Compose changes, removed routes, a new plugin SDK version), and writes reader-facing notes with upgrade steps first. Writes a Markdown file outside the repo; does NOT tag, publish a release, edit an existing release without asking, or commit.
---

# Writing Direx release notes

GitHub's generated notes are a list of PR titles. That list stays as the last section; above it, the
notes tell a self-hoster what changed for them and what they must do before upgrading.

## Inputs

- The new version (from `cut-release`, or ask) and the commit it will tag: a SHA on `origin/main`,
  never the `HEAD` of a checkout with local work.
- The previous release: `git tag --list 'v*' --sort=-v:refname | head -1`.

If `gh release view <version> --repo trydirex/direx` already shows notes, read them and ask whether
to keep them, refresh sections or rewrite them. Never replace them silently.

## 1. Collect the range

With `PREV` the last tag and `SHA` the release commit:

```bash
git fetch origin --tags
git log --oneline --merges PREV..SHA                 # one merge per PR
gh pr list --repo trydirex/direx --state merged --base main --limit 200 \
  --search "merged:>=$(git log -1 --format=%cs PREV)" --json number,title,author,body,mergeCommit
gh api repos/trydirex/direx/releases/generate-notes -f tag_name=<version> -f target_commitish=SHA \
  -f previous_tag_name=PREV --jq .body               # the PR list for the last section
```

Keep only PRs whose merge commit is in `PREV..SHA`. A PR merged after `SHA` ships next time.

## 2. Find what a reader must act on

Check each, and read the PR descriptions for anything they flag:

```bash
git diff --name-only PREV..SHA -- packages/db/migrations/   # new migrations
git diff PREV..SHA -- deploy/                                # Compose, install.sh, Caddy, image
git diff PREV..SHA -- packages/plugin-sdk/package.json       # SDK version bump
git diff --stat PREV..SHA -- docs/ README.md                 # docs the website will pick up
```

- **Migrations**: a backfill, a `-- direx:no-transaction` index build on a large table, or a dropped
  column means the upgrade may take time or downtime. Say how long it might take, or say you don't
  know.
- **Install and Compose**: a new or renamed `.env` key, a new service, a changed port. Spell out what
  to add or change. `install.sh` won't change `DIREX_VERSION` itself, so every upgrade starts with
  editing that line in `deploy/compose/.env`.
- **API and routes**: a removed or renamed route or field that the outside door or an integration
  uses.
- **Plugin SDK**: if its version changed, `release-sdk` publishes it on this tag. Plugin authors get
  their own section.
- **Security**: list a fix only after its advisory is published (`advisory-fix`). Before that,
  call it a hardening at most, or leave it out.

## 3. Write the file

Write `release-notes-<version>.md` in a temp or scratch directory, not in the repo. Group related PRs
into one entry and describe what a person can now do, not how the code changed. Leave out refactors,
CI and docs-only work unless a reader would notice. Use the words the app uses (Workspace, Item,
Campaign, Mailbox), plain sentences, and no em or en dashes.

```markdown
## Before you upgrade
<only when there is something to do: steps in order, starting with setting DIREX_VERSION=<version> in deploy/compose/.env>

## New
- **<Feature in reader words>.** One or two sentences. (#123)

## Better
## Fixed
## For plugin authors
<only when the SDK changed: the new @trydirex/plugin-sdk version and what it adds or breaks>

## Security
<only for published advisories: the GHSA link, the CVE when assigned, and credit if the reporter wants it>

## All changes
<the generated PR list from step 1>
```

Drop any empty section other than New and Fixed. Link each entry to its PR as `(#N)`. Credit
contributors other than maintainers and bots by GitHub handle; never an email or a real name the
person didn't give.

## 4. Check it before handing over

- Every "Before you upgrade" step was checked against the diff, not taken from a PR title.
- No entry describes a PR outside `PREV..SHA`.
- No unpublished security detail.
- Then give the maintainer the file path and a short summary. Publishing is `cut-release`'s job.
