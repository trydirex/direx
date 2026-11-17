# Contributing to Direx

Thanks for wanting to help. Direx has one maintainer with a few hours a week, so these rules keep
reviews possible. The founder makes the final call on what gets merged.

**Pull requests from outside can't be merged yet.** The [Contributor License Agreement](CLA.md) is
still a draft, and nothing is merged without it. Until it is in force, issues and security reports
are welcome, and a pull request will wait.

## Before you write code

- **Work on an `accepted` issue.** Only issues with the `accepted` label are open for outside PRs.
  Comment on the issue to claim it, so two people don't build the same thing. A PR without an
  accepted issue is closed, however good it is.
- **Want something else?** Open an issue and describe it. If the maintainer labels it `accepted`,
  it's yours.
- **Read [AGENTS.md](AGENTS.md)** for the commands and layout, and
  [CONSTRAINTS.md](CONSTRAINTS.md) for the quality bar. Don't weaken `CONSTRAINTS.md` to make a
  change pass.

## Your pull request

- Keep it under 500 changed lines and 10 files. Split bigger work into several PRs.
- Run `bun run check:task` and make sure it passes before you open the PR.
- Fill in the PR template, including the link to the accepted issue.
- The maintainer replies within 14 days. If you hear nothing by then, comment on the PR.

Changes to approvals, the action ledger, tenancy, credentials, migrations, `CONSTRAINTS.md` and
the checks in `scripts/` always need the maintainer's review. Those PRs take longer.

## AI-written code

AI-written code is welcome, and you don't have to say you used it. You do have to understand it:
the maintainer may ask you to explain any line, and "the model wrote it" isn't an answer.

## Where code comes from

- **Channel and provider code is written from the platform's own API documentation.** Link the
  docs you used in the PR. Never copy code from Postiz or any other AGPL project.
- **No third-party AGPL or GPL code or dependencies.** The CLA can't relicense code we don't hold
  the rights to. `bun run check:license` refuses an installed dependency whose license isn't on
  its list, so a new license is read by a person first.
- Third-party code under other licenses keeps its original header and license notice.

## License and CLA

The core is AGPL-3.0-only, and `packages/plugin-sdk` and `skills/` are MIT. Every TypeScript and
JavaScript source file starts with an SPDX header; `bun run check:license` checks it. Everything
without a header, such as migrations, docs and prompts, is under the root [LICENSE](LICENSE).

Before your first PR is merged, you sign the [Contributor License Agreement](CLA.md). Once the
agreement is in force, a bot will ask you on the PR, and signing takes one click. The CLA lets KD Partners LTD, the company behind Direx, license your contribution on
any terms, including the paid cloud. We use a CLA, not a DCO sign-off.

## Security problems

Don't open a public issue. See [SECURITY.md](SECURITY.md).

## Conduct

Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).
