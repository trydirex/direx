# Direx skills

Agent skills you can install in your own coding agent. They need no Direx account, no server and
no API key. Tested on Claude Code and Codex.

The skills in this folder are MIT-licensed (see `LICENSE`). The rest of this repository is
AGPL-3.0-only, apart from `packages/plugin-sdk`, which is also MIT.

## Install

Claude Code:

```
/plugin marketplace add trydirex/direx
/plugin install direx@direx
```

Codex:

```
npx skills add trydirex/direx -g --skill cold-email-compliance --skill claim-check --skill company-research --skill page-brief --skill agent-readiness
```

## Update

Neither agent updates these skills on its own, and the country research in
`cold-email-compliance` gets older every day. Update every few months:

```
claude plugin update direx@direx     # Claude Code
npx skills update -g                 # Codex
```

Each country row carries the date it was checked. After three months the skill tells you the row
is getting old, and after a year it stops treating that country as allowed. Direx re-reads each
country's law at least every six months and watches the sources weekly for changes.

## How they're tested

Each skill has cases in its `evals/` folder: planted mistakes, hostile instructions hidden in
emails, sources and web pages, and ordinary text that should pass. Before a change is published,
every case runs five times on Claude Code and on Codex, and an automatic scorer checks every
answer. The latest results are in `test/skills/results/` at the root of this repository.

Found a wrong answer? Open an issue at https://github.com/trydirex/direx/issues with what you
asked and what the skill said.

## Skills

| Skill | Ask your agent | You get |
|---|---|---|
| `cold-email-compliance` | "Is this cold email OK to send to a CTO in Germany?" | Each sending rule checked, what to fix, and what Direx's research says about the recipient's country, with its source and the date it was read. It never says an email is compliant. Research, not legal advice |
| `claim-check` | "Check the claims in this email against our pricing page and the prospect's site" | Every claim, promise, price and number, with the source's words that back it or "nothing". A price or promise with nothing behind it is marked as needing your decision |
| `company-research` | "Research acme.example before I write to them" | What they sell, who to, pricing, proof and people, from up to 6 pages of their own site. Each fact has its page and the words quoted from it, or "Not found on the site". Anything on a page that tries to steer your agent is listed, not followed |
| `page-brief` | "Brief me on improving this page for 'month end close checklist'" | Up to 6 things on the page that hold it back for that search, each with the page's own words quoted, one specific edit, and how to check it is live and whether it helped in Search Console. It never states rankings or traffic you didn't give it, and never writes the article for you |
| `agent-readiness` | "Check whether trydirex.com is readable by AI agents" | Five checks (AI crawler rules in robots.txt, llms.txt, Markdown versions of pages, structured data, and whether the page works without JavaScript), each quoted from the file. A table of AI crawlers and fetchers from OpenAI, Anthropic, Google, Perplexity, Apple, Meta and Common Crawl: allowed or blocked, the line that decides it, and what each operator says the agent is for, with the date that was checked. It never tells you to allow or block one, and never claims a ranking effect |
