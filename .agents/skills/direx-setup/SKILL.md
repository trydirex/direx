---
name: direx-setup
description: Install Direx from a fresh clone and hand over at the sign-in page. Use when someone asks to set up, install or run Direx on their machine.
---

# Set up Direx

The commands hold the logic. Run them and follow what they print.

## Steps

1. From the repo root, run `bun run setup`. If Bun or Docker is missing, install it or ask the person
   to, then run setup again.
2. If a line starts with `FAIL`, do what it says, then run `bun run doctor`. Repeat until every line
   starts with `ok`. Don't fix things another way, and never delete a Docker volume or a key file to
   get past a failure: a volume holds the person's data, and a key file is what reads their stored
   credentials.
3. Start `bun run dev` as a background process.
4. Check that `http://localhost:5173` answers.
5. Tell the person the address, and that they press **New here? Sign up** there. If the app may stop
   when you finish, as it will in a one-shot run, don't say it is running: tell them to run
   `bun run dev` themselves. Then stop.

## What only the person does

- **Their sign-in.** Never create their sign-in, choose or type a password, or sign in.
- **Links.** The app prints sign-in and reset links to its log. Don't read them or pass them on. If
  the person asks for one, tell them to look at the terminal output themselves, or to use a password.
- **The bootstrap link.** On a production server (`NODE_ENV=production`), setup and
  `bun run server-admin --invite` print a link that makes whoever opens it the first Server admin.
  Don't run either there: tell the person to run them. Never read, print or pass the link on.
- **Keys.** Never ask for, read or type a key. The person runs this themselves:
  `bun apps/api/src/secrets.ts set <name>`
- **Approvals.** Never approve anything in Direx.

If the person sets up Google sign-in (`DIREX_GOOGLE_CLIENT_ID`, and the client secret they store themselves as `signin.google`),
tell them to turn on the Search Console API in that Google OAuth client's project, so the SEO page
can connect: https://console.cloud.google.com/apis/library/searchconsole.googleapis.com

Also tell the person to back up `~/.direx/master.key`, once it exists, separately from the database.
