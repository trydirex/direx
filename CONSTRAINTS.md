# Constraints

Last reviewed: 2026-11-09 by the founder (accessibility moved to WCAG 2.2 on the sign-in page and Home signed in; first-load bundle budget; page speed signed in measured). This is the bar for "good enough to ship". Every failing
check blocks: the agent fixes the code, it does not change this file to get to green. Tightening a
number needs no approval. Loosening one, or adding an exception, needs the `constraints-approved`
label on the pull request, which a person applies.

## Floor (always enforced)

Checked on the diff by `bun run check:floor`.

- No new suppressions: `@ts-ignore`, `@ts-nocheck`, `eslint-disable`, coverage ignore comments, `nosemgrep`, `gitleaks:allow`. `@ts-expect-error` is allowed only in a test, where it proves a call does not compile
- No unfinished work: a "not implemented" throw, an empty `catch`, a `TODO`
- No easier tests: no skipped or deleted test, and no net loss of assertion lines in a test file
- No secrets in source
- This file does not get weakened to make a change pass

## Enforced with numbers

| Dimension | Rule | Why this number | Checked by | Runs at |
|---|---|---|---|---|
| Lint | Zero errors | Our own config, including the 1,500-line file limit | `bun run lint` | every edit (edited file), task end, CI |
| Types | Zero errors | A type error is a bug the compiler already found | `bun run typecheck` | task end, CI |
| Boundaries | Zero violations | Module layering and cycle rules from the ADRs | `bun run check:deps` | CI |
| Migrations, licensing, manifest | Zero violations | Immutable migrations and the AGPL/MIT boundary | `check:migrations`, `check:license`, `check:package` | CI |
| Tests | All pass | A red test is a broken promise | `bun run test:coverage` | task end, CI |
| Coverage: changed lines | >= 80% of lines | Forces a test but allows a config line | `bun run check:coverage` | task end, CI |
| Coverage: project | >= 80% of lines in `apps` and `packages` | Standard target; 88.33% on 2026-10-30, so it holds today | `bun run check:coverage` | task end, CI |
| Secrets | Zero findings | One leaked key is enough | `bun run check:security` (gitleaks) | CI |
| Dependencies | Nothing at CVSS 7.0 or above, and nothing unscored | Below high is mostly noise; 6.9 is the highest today | `bun run check:security` (osv-scanner) | CI |
| Code security | Zero Semgrep error-severity findings | `p/default` errors are rarely false alarms | `bun run check:security` (Semgrep) | CI |
| Page speed | LCP at most 2500 ms | Core Web Vitals "good" threshold | `bun run check:web` (Lighthouse) | CI |
| Layout shift | CLS at most 0.1 | Core Web Vitals "good" threshold | `bun run check:web` (Lighthouse) | CI |
| Accessibility | Zero critical or serious WCAG 2.2 A/AA violations, on the sign-in page and on Home signed in | Moderate and minor are often debatable; 2.2 adds target size and focus not obscured | `bun run check:web` (axe-core in Lighthouse) | CI |
| First-load bundle | At most 240 kB JS and 16 kB CSS, gzipped | 140 kB and 11 kB on 2026-11-09, with room to grow | `bun run check:web` | CI |

80% is the floor, not the goal. We want as much test coverage as we can get: every line a change
adds or touches gets a test that runs it and checks what it does, and a change that passes a file
with uncovered lines covers them when it can. A line that truly can't run under test, such as
process startup, is the only one left out. Raise the two coverage numbers above as the project
climbs; tightening needs no approval.

`bun run check:task` is the task-end stage, with a 150-second budget. The founder raised it from 90 seconds on 2026-11-05, when `typecheck` began to cover `apps/api` and `apps/web`, which it had never checked (about 78 seconds before, 100 to 110 after), and from 120 to 150 seconds on 2026-11-09, when the web redesign added browser tests, `check:web-rules` and the router's type inference (121 to 127 seconds measured that day). It needs a merge base with
`origin/main` (override with `DIREX_BASE`), so it exits 2 until the first commit exists.

Secrets, dependencies and page checks are judged by outside tools, which an agent cannot satisfy by
writing a weaker test.

## Measured, not yet enforced

| Metric | Today (2026-10-30) | Direction |
|---|---|---|
| Page speed signed in | Home: LCP about 3200 ms, CLS 0.02 (2026-11-09), measured by `check:web` as a fixture person | Enforce LCP at most 2500 ms on Home once it passes |

## Exceptions

| ID | Rule | Path | Reason | Owner | Expires |
|---|---|---|---|---|---|
| E1 | gitleaks `generic-api-key` | 3 test files and `scripts/eval.ts`, listed in `.gitleaks.toml` | Fake secrets in tests, and one comment naming an env var | founder | 2027-01-28 |
