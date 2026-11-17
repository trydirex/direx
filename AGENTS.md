# Direx for coding agents

To install Direx for someone, use the `direx-setup` skill in `.agents/skills/`. The rest of this
file is for changing the code.

## Commands

```
bun run setup                       prepare a checkout, safe to re-run
bun run doctor                      report problems and their fixes, changes nothing
bun run dev                         API on 3000, web on 5173
bun run test                        tests, which need the database from setup
bun run check:task                  run this before calling work finished
bun run check:full                  everything CI's ci job runs on each change
bun scripts/check-first-run.ts      setup to sign-in, in a temporary copy
```

## Layout

- `apps/api`: the server and worker, split into modules under `src/modules`. A module's `index.ts`
  is its only public entry point. A module's eval cases and scoring sit in its `evals.ts`, which only
  tests and scripts import, and fixtures are for tests only. `bun run check:deps` enforces all three.
- `apps/web`: the web app.
- `packages/db`: the schema and migrations.
- `packages/plugin-sdk`, `packages/extensions`: the plugin contract and first-party plugins.
- `scripts`: the checks and first-run commands.

## Rules

- Read `CONSTRAINTS.md` before writing code, and don't weaken it to make a change pass.
- Don't commit, branch, push or open a pull request unless a person asks for that action.
- Never edit, rename or delete a merged migration. Add a new one.
- Each migration file runs in its own transaction. `CREATE INDEX CONCURRENTLY` needs a file whose first
  line is `-- direx:no-transaction`, holding one statement per `--> statement-breakpoint` chunk, with
  `DROP INDEX CONCURRENTLY IF EXISTS` before each build. A new tenant table enables and forces its RLS in
  the same file. `bun run check:migrations` checks both, and the tables in `receipts.json`'s `large` list.
- Never put a secret in the repo, or a key in `.env`. Secrets go in the vault through
  `apps/api/src/secrets.ts`, typed by a person.
- Nothing reaches the outside world without a person's approval or a rule a person granted. Don't add a path around the ledger
  or approval checks, and never approve anything on someone's behalf. A person's recorded yes to warmup is such a grant,
  for one self-hosted Mailbox, and warmup email still goes through the ledger. So is a yes to Placement checks: a grant
  for one self-hosted Mailbox, and every placement email (checks, reports, joins, archiving) still goes through the ledger.
  So is a yes to status write-back: a grant for one imported docs source, and every write still goes through the ledger.
- Don't read sign-in or reset links from the app's log, or sign in as a person. The one exception: on a local
  dev server, when the developer running it asks you to test the app, you may sign in as them with a magic link
  from the dev log. Never print that link, and never do this against a hosted Direx.
- The bootstrap link makes whoever opens it the server's first Server admin. `bun run server-admin --invite`
  prints it, and so does `bun run setup` on a production server with no Server admin. It belongs to the person:
  don't read, print or pass it on, and don't run either command on a production server yourself. The dev
  magic-link exception doesn't cover it.

## Pull requests

These rules apply to every coding agent, whoever runs it. People follow the same rules in
`CONTRIBUTING.md`, and `scripts/check-pr.ts` checks the title, the template, the linked issue and the
size in CI.

- A person opens every pull request and answers for it. You can prepare the branch, the commits and
  the description. Push or open a PR only when that person asks, open it as a draft, and never push
  to `main`.
- From outside the project, work only on an issue labelled `accepted`, and start the description with
  `Closes #N`. Never invent an issue number.
- Title: one imperative sentence of at most 72 characters, starting with a capital letter, with no
  `feat:`-style prefix and no full stop. Pull requests are squash-merged, so the title and description
  become the commit on `main`.
- `gh pr create` and the API don't load the template. Copy `.github/pull_request_template.md` into the
  description and replace each "Replace this line" placeholder.
- Under Verification, list each command you ran and its result, and write
  `Not run: <command> (<reason>)` for any you skipped. `bun run check:task` must pass.
- Never add a `Co-authored-by:` trailer for an AI tool, yourself included: the CLA check can read it as
  a person who hasn't signed. Saying which tools helped is optional; use the template's "AI use"
  section or an `Assisted-by: <tool>` trailer.
- Keep a PR to 500 changed lines and 10 files, not counting `bun.lock` and
  `packages/db/migrations/meta/`. Split bigger work.
- Leave `CONSTRAINTS.md`, `CLA.md`, `.github/` and merged migrations alone unless the issue asks for a
  change there.
