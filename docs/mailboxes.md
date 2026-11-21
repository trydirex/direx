# Connecting a Mailbox with a password

Self-hosted Direx can send from any mail account that offers SMTP and IMAP, so you don't need a
Google app of your own. Direx cloud doesn't offer this.

1. Create an app password at your mail service. Gmail, iCloud, Fastmail and Yahoo all require one
   for this kind of connection. Your normal password won't work.
2. In Direx, open Settings, then Email and keys, then "Connect an email account with a password".
3. Pick your mail service to fill in the servers, or type them in.
4. Enter your sign-in name and the app password. Direx signs in to both servers before saving
   anything, and tells you which one refused. Once connected, it sends one test email to that
   address to check that your mail service leaves the unsubscribe link unchanged.

## What Direx does with the account

- It sends only what someone approved.
- It reads the inbox and the Sent folder, read-only. It never marks mail as read, moves it or
  deletes it.
- The password is encrypted in the vault. The server names are stored in the clear.

TLS is always on, and certificates are always verified. Port 465 uses TLS from the start. Any
other sending port must offer STARTTLS, or the connection is refused. A mail server with a
self-signed certificate can't be connected.

## Your own Google app

Gmail Mailboxes connect through a Google OAuth app. A Workspace can bring its own, so its Gmail
doesn't depend on the server's app. An app that belongs to your Google Workspace organisation and is
set to Internal needs no verification from Google and has no cap on users.

Gmail picks an app in this order:

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:e25b8b5a362cfba95c5de4c07450f77de82b135f61b299f7cfb851bb9ea4648a -->

1. The Workspace's own app, set through the credentials API below.
2. The server's mailbox app, the system secret `social_app.google`. See
   [Deployment secrets](deployment-secrets.md#gmails-mailbox-app).
3. The server's sign-in app, `DIREX_GOOGLE_CLIENT_ID` with the `signin.google` secret.

With none of the three, Direx doesn't offer Gmail.

To set up your own:

1. In the Google Cloud console, create a project, or pick one you already have.
2. Under APIs and services, enable the Gmail API.
3. Set up the OAuth consent screen. Choose Internal if your Mailboxes belong to a Google Workspace
   organisation. For personal Gmail accounts, choose External and set the publishing status to In
   production. Never leave it in Testing: Google expires the refresh tokens of an app in Testing
   after 7 days, so every Mailbox would need reconnecting each week.
4. Under Credentials, create an OAuth client ID of type Web application. Add the authorized
   redirect URI `<base URL>/api/connections/callback`, for example
   `https://direx.example.com/api/connections/callback`.
5. As a Workspace Owner or Admin, sign in again and make an authenticated JSON request to
   `POST /api/w/{workspaceId}/credentials` within 10 minutes of signing in. Use your Workspace ID
   in the path. Put the Google client ID in `meta.username` and the client secret in
   `value.password`:

   ```json
   {
     "scope": "workspace",
     "kind": "basic",
     "key": "oauth_app:google",
     "name": "Gmail app",
     "meta": { "username": "<Google client ID>" },
     "value": { "password": "<Google client secret>" }
   }
   ```

   The API returns the credential metadata, including the client ID. It never returns the secret.

<!-- /coderabbit-ai-generated:v1 -->

Direx asks Google for `gmail.modify` and the account's email address, and nothing else.

A refresh token works only with the app that issued it. So saving, changing or removing the app
makes each Gmail Mailbox in the Workspace need reconnecting, once. Until a Mailbox is reconnected,
its scheduled email waits. Removing the app moves Gmail back to the server's app, if there is one.

## Replies and opt-outs

This applies to every Mailbox, Google ones included. Direx checks the inbox for replies to the
mail it sent.

- A reply that asks to stop opts out every address of that Person at once. An approved email to
  them that hasn't gone yet is blocked.
- A reply that rules can't settle holds that Person's mail until a model decides, if one is
  connected, or someone answers the question in Review. If nobody decides within 30 days, Direx
  deletes the reply's text, and the hold stays.
- A hard bounce stops mail to that address.
- When 3 of a Mailbox's latest 50 emails bounce for good, Direx pauses that Mailbox. A sender
  block counts too. Nothing goes from a paused Mailbox, not even email a standing rule covers, until
  an Owner, Admin or Marketer presses Resume on its card in Settings. Bounces from before a resume
  don't count again. Anyone who edits can also pause a Mailbox by hand.
- If Direx can't read a Mailbox's replies, it holds that Mailbox's cold email until it can again.

Only an Owner can undo an opt-out, and only one that was read from a reply. They sign in again and
give a reason. Direx keeps the reason with the original words, and a later "stop" opts the Person
out again. Unsubscribe clicks and bounces can't be undone.

## Sending a Campaign step from several Mailboxes

One Mailbox sends at most its daily limit, so an email step can use several. Tick them under Email
accounts in the step's settings. Each new email goes from whichever Mailbox has the earliest free
time, and the Mailboxes take turns when their times match. A person keeps the Mailbox their first
email in the Campaign came from, so a follow-up doesn't arrive from a stranger. A draft never
changes Mailbox once written: taking a Mailbox off a step leaves its drafts on it.

## If a send is cut off

If the connection drops while a message is going out, Direx can't tell whether it was delivered.
It looks in your Sent folder for that message and marks it sent if it finds it. If it doesn't,
Direx asks you to check, and doesn't resend on its own. A service that keeps no Sent copy for mail
sent this way always ends with that question, and Direx warns you when it can't find a Sent folder.

## Placement checks

The Circle members of a Placement circle send each other short test emails, Placement checks, and report where each one
landed: primary, another tab, spam or missing. It runs only on a self-hosted install, only for
Gmail Mailboxes, and never on Direx cloud. Nothing happens until both of these are true:

- **The install has a list.** Set `DIREX_PLACEMENT_LIST` to the path of your checkout of the
  circle's private list repository, the folder holding `members.json`. Pull it whenever the
  signer publishes a new version. With no list, no check is planned, sent, read or reported.
- **The Mailbox has a yes.** The person who connected the Mailbox answers on its screen, after
  reading what is sent and read. Any member of the Workspace can stop it with one click.

The Google OAuth app your Gmail Mailboxes connect through (see
[Your own Google app](#your-own-google-app)) must have its publishing status set to **Internal** or
**In production** in the Google Cloud console. Don't run
Placement checks on an app in **Testing**: Google expires its refresh tokens after 7 days, so
the Mailbox drops out of the circle partway through a week.

Checks, reports and join replies are approved Actions like any other email. They skip Touches,
but never the suppression list, and a sending-limit refusal from Google stops placement for
that Mailbox.

If you sign the list, keep the signer key offline, outside this checkout and the list folder.
[Signing the Placement circle's member list](placement-signer.md) covers the key and every
signer command.

## Adding a mailbox provider

A provider is a plugin whose manifest declares `email.send`, `email.received`, `mailbox.profile`
and `mail.from` on one connection. Add it to `firstPartyPlugins()` and describe how to connect it
in `mailboxProviders()`, both in `packages/extensions`. Nothing in `apps/` changes.

## Checking a real mail service

`scripts/imap-smtp-smoke.ts` sends one message and reports whether the service keeps a Sent copy
and whether the Message-ID and the `X-Direx-Action` header survive. Usage is at the top of the file.
