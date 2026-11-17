# Social

Direx writes posts for your Social accounts and publishes only the ones someone approved. Where a
Network can't publish through Direx yet, you get the approved text to copy and post yourself, and
Direx never says it posted it.

## Networks today

Open Settings, then Social accounts. The Networks list shows every Network Direx knows of, each
marked Available, Awaiting platform approval, Not yet built or Not available.

- LinkedIn, X, Bluesky, Facebook and Threads can publish once an account is connected.
- Instagram can be connected, but publishing to it isn't built yet.
- The rest are listed as Not yet built, and you can post to them by copy and paste.

## Connecting an account

You need any role except Viewer.

1. Open Settings, then Social accounts.
2. Under Networks, click "Connect" with the Network's name. Most Networks send you to their own
   sign-in. Bluesky asks for your Bluesky handle and an app password from Bluesky's settings, and
   checks them before saving anything.
3. If the login can post to more than one place, such as a profile and the Pages you run, Direx
   asks "Which accounts should Direx post to?". Tick them and click Add. A login with one account
   is added at once.

The account then shows under Connected, with its status (Working, Reconnect needed or Revoked) and
what it can do: publish posts, links in posts, follow-up comments, post video, read stats and
comments. Each says yes, coming, needs your own app keys, or reconnect to enable. When a Network's
access is about to end, the row says "Reconnect by" and the date, starting 14 days before.

Direx checks each account once a day. If the Network refuses it, the account shows Reconnect needed.

To disconnect, click Disconnect on the row. You can disconnect your own login; an Owner or Admin
can disconnect any. Direx asks you to sign in again first. The account's history stays.

## Writing posts

Posts belong to a post step in a Campaign.

1. Open the Campaign and find the post step.
2. Under "Where it goes", tick the accounts. Networks you post to by hand say "(copy and paste: you
   post this yourself)".
3. Click "Write it for me" to have the Social Agent fill in the text, or write it yourself. Tick
   "Write a version for each account" to give each account its own text.
4. Add a follow-up comment or a video (MP4, MOV or WebM, up to 2 GB) if you want, and set When.
5. Click "Check against each network" to see what each post will become. If a Network would change
   the text, for example by removing links, it shows what the post will read.
6. Click "Write drafts". Each account gets its own post, waiting for approval.

Direx warns you when the same text goes to several X accounts, when another post on that account is
planned within 15 minutes, and when another Campaign launches that day.

## Approving and publishing

Click Approve on a post, or "Approve all" to approve every post without warnings at once. Writing
the step's drafts again changes the posts, and any approval they had is taken back.

An approved post shows "Approved and scheduled" and goes out at its time. Once the Network confirms
it, the post shows Published with a link to open it. A post that is stopped shows "Not published"
and the reason.

For a copy-and-paste post, approval changes nothing outside Direx. After approval:

1. Click "Copy text", and "Download video" if it has one.
2. Post it yourself on the Network.
3. Paste the link to your post if you like, and click "Mark as posted by you".

It then shows "Posted by you".

A Network that fetches the video itself, such as Threads, needs Direx at a public HTTPS address.
Without one, that post becomes copy and paste.

## Daily limits

Each account has a daily budget, to lower the risk of a restriction. It can't rule one out.

- A new account starts at 1 post and no links a day. After 7 days with no warnings, it can do one
  more of each, up to 5 posts and 3 links a day. The day is counted in UTC.
- A post that would go over the budget is held, and the account row shows today's use.
- If the Network throttles the account or flags a post as spam, Direx pauses the account and halves
  its budget. Posts wait until someone clicks "Lift the pause". The budget stays halved.
- If a Network removed a post or restricted the account, click "A post was removed or the account
  restricted". Direx pauses the account the same way.
- To set a lower budget, change "Posts a day" or "Links a day" and click "Lower the limit". Nothing
  here raises a budget.

Owners, Admins and Marketers can lift a pause, report a removal and lower a limit. A copy-and-paste
post can't be held, since you post it, so going over the budget only warns.

## Cloud and self-hosted

Connecting through a Network's sign-in needs an app registered with that Network.

- **Direx cloud** uses the deployment's own app for each Network. A Network with no app set up
  shows Not available. On X, Direx's own app allows 500 posts a month per Workspace, after which
  posts are held. Links on X need your own X app.
- **Self-hosted**, an Owner or Admin opens "Set up" with the Network's name, follows the steps to
  register an app in the Network's developer console, and pastes its client ID and client secret.
  The page shows the callback URL and the permissions to allow. Other members see "An Owner or Admin
  can set this up."

A deployment's operator can also store one app for a Network for every Workspace, as
`<client id>:<client secret>` on stdin:

```
printf %s "$CLIENT_ID:$CLIENT_SECRET" | bun apps/api/src/secrets.ts set social_app.<network>
```

`<network>` is the Network's connection name, such as `linkedin`, `x`, `facebook` or `threads`.
Bluesky needs no app.
