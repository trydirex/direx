# Security

## Reporting a problem

Please don't open a public issue. Report it privately in one of two ways:

- GitHub: **Security** tab, then **Report a vulnerability**.
- Email: dominik@trydirex.com

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a
reply within 7 days. Please give us a chance to fix it before you publish anything.

## What's in scope

Anything in this repository, including:

- server-side request forgery (SSRF), for example through page fetching or webhooks
- reading or changing another Workspace's data
- sending, posting or spending without a person's approval or a granted rule, or getting around
  the action ledger
- exposing stored credentials or the root key
- the usual web problems: injection, XSS, broken sign-in or sessions

## Supported versions

Only the latest release gets security fixes.

## Rewards

There is no bug bounty. We'll credit you in the fix's release notes if you'd like.
