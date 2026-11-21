---
name: cut-release
description: Use when a Direx maintainer asks to ship, tag or cut a release, or to check that a release went out. Picks a green commit on origin/main and the next v0.x.y version, has release-notes draft the notes, pushes the tag that triggers the release-image (ghcr) and release-sdk (npm) workflows, creates the GitHub Release, checks both artifacts exist, and lists the follow-ups. Pushes the tag and creates the release only on the maintainer's go-ahead in this session. Does NOT move or delete a pushed tag, retag latest by hand, merge PRs or push to main.
---

# Cutting a Direx release

Maintainers only: it needs write access to `trydirex/direx`.

A release is one git tag. Pushing a `v*` tag starts two workflows:

- `.github/workflows/release-image.yml` builds `deploy/docker/Dockerfile` for amd64 and arm64 and
  pushes `ghcr.io/trydirex/direx:<tag>` and `:latest`. `deploy/compose/install.sh --version <tag>`
  pulls that image.
- `.github/workflows/release-sdk.yml` publishes `@trydirex/plugin-sdk` only if the version in
  `packages/plugin-sdk/package.json` isn't on npm yet. Most releases skip it.

An admin can do steps 1, 2 and 4 with one click: `.github/workflows/release.yml` tags the next version
on `main`, runs both workflows and creates the GitHub Release. By hand, the release is created after
the tag. `SECURITY.md` says only the latest release gets security fixes, so every release becomes the
supported one.

## Ground rules

- A pushed tag is public, and `:latest` moves with it. Push the tag and create the release only after
  the maintainer says go in this session, and show them the exact commands first.
- Never move, delete or re-push a tag that is already on the remote (that is a force-push). A bad
  release is fixed by the next patch.
- Work from a clean worktree on `origin/main`, not a checkout with local changes.

## 1. Pick the commit

```bash
git fetch origin --tags
SHA=$(git rev-parse origin/main)
gh run list --repo trydirex/direx --commit "$SHA" --json name,status,conclusion
```

`ci` and `install` must have passed on that exact SHA (`install` runs on every push to `main`). If
either is pending, wait; if either failed, stop and report it. The maintainer may name an older green
SHA instead.

## 2. Pick the version

```bash
PREV=$(git tag --list 'v*' --sort=-v:refname | head -1)
git log --oneline --merges "$PREV..$SHA" | wc -l     # nothing to release if 0
```

Direx is on 0.x. Bump the patch (`v0.1.5` to `v0.1.6`) by default. Bump the minor (`v0.2.0`) when a
self-hoster must do more than change `DIREX_VERSION`: a new required `.env` key, a long backfill, a
removed route or setting. When unsure, ask.

If `packages/plugin-sdk/` changed since `PREV` but its `version` didn't, say so before tagging: the
SDK change won't reach npm, and the version bump needs its own PR.

## 3. Draft the notes

Run `release-notes` with the version, `PREV` and `SHA`, show the maintainer the file, and wait for
their edits or approval. Read every "Before you upgrade" step against the diff yourself.

## 4. Tag and release (on the maintainer's go)

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:494f075e7dba26af7770a1cab4ea452a43aaf6ac7c3c83ea2e97c1b945446fb8 -->

If the maintainer is an admin and `SHA` is the tip of `main`, use the button:

```bash
gh workflow run release.yml --repo trydirex/direx --ref main -f bump=patch -f expected_sha="$SHA"    # or minor
gh run watch --repo trydirex/direx <run-id>
gh release edit <version> --repo trydirex/direx --notes-file <path>/release-notes-<version>.md
```

The workflow stops before tagging if its commit differs from the approved `SHA`. If `main` advanced,
repeat steps 1–3 and get approval for the new commit before dispatching again. The workflow checks
`ci` and `install` on that SHA and refuses `patch` if `deploy/compose/.env.template` gained a setting.
Watch the run from this dispatch. Only edit the notes once its GitHub Release job succeeds for the approved
SHA, using the version it released. The image and SDK jobs run inside this run, so step 5 reads it.

<!-- /coderabbit-ai-generated:v1 -->

Otherwise, by hand:

```bash
git tag -a <version> "$SHA" -m "<version>"
git push origin <version>
gh release create <version> --repo trydirex/direx --verify-tag --title <version> \
  --notes-file <path>/release-notes-<version>.md
```

Use annotated tags (`-a`): they record who tagged and when.

## 5. Check what went out

```bash
gh run list --repo trydirex/direx --workflow release.yml --limit 1         # button releases
gh run list --repo trydirex/direx --workflow release-image.yml --limit 1
gh run list --repo trydirex/direx --workflow release-sdk.yml --limit 1
docker manifest inspect ghcr.io/trydirex/direx:<version>   # lists amd64 and arm64
npm view @trydirex/plugin-sdk version                       # only if the SDK version changed
gh release view <version> --repo trydirex/direx
```

Wait for both runs to finish. If time allows, prove the image installs: copy `deploy/compose/` to a
scratch directory on a machine with nothing on port 3000, run
`sh install.sh --version <version>` there, then `curl -fsS http://127.0.0.1:3000/health`. Never do
this on a real server.

## 6. Follow-ups

- **Docs site**: trydirex.com renders its docs from the release named in the website repo's
  `direx.tag`. If that's behind, bump it there. Doc fixes go in this repo, never the website.
- **Announcement**: offer a short post from the notes; send nothing without the maintainer.

## When something fails

| Failure | What to do |
|---|---|
| the button stopped before tagging | its error says why (not an admin, `ci` or `install` not green, nothing merged, a new setting on `patch`); fix that and run it again |
| `release-image` failed | read `gh run view <id> --log-failed`; rerun once if it was infrastructure; otherwise fix on `main` and cut the next patch |
| `release-sdk` failed | after a fix lands, retry with `gh workflow run release-sdk.yml -f release_tag=<version>` (it checks the SDK files match the tag) |
| the release is broken for users | fix forward with the next patch at once; tell the maintainer before anyone suggests repointing `:latest` |
| `gh release create` failed after the tag pushed | run it again; the tag and image are fine |

## Report

The version and SHA, `PREV`, both workflow results with links, the image tag (and the SDK version if
one was published), the release URL, the docs site's `direx.tag`, and anything still open.
