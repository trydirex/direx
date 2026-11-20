# SEO and Google Search Console

Direx reads your search data from Google Search Console and suggests Briefs: one page and one
search, what on the page holds it back, and how to fix it. Direx only reads Search Console. It never
changes anything there, and it never changes or publishes your pages. The SEO page is marked Beta.

## Connecting Search Console

1. Open Campaigns, then SEO.
2. Press "Connect Search Console" and allow Search Console access on Google's consent page. A
   Viewer can't connect it.
3. Back in Direx, pick the site under Property and press Save. Only an Admin or Owner can choose
   the property. The list holds the sites this Google account can see in Search Console. If it's
   empty, add your site in Search Console first, then come back.

To switch sites later, press Change next to the property.

### The Google app

Connecting needs a Google app (an OAuth client). Direx uses the first of these it finds:

1. The Workspace's own app. An Owner or Admin sets it up on the SEO page, under "Set up a Google
   app for Search Console": turn on the Search Console API in a Google Cloud project, publish its
   OAuth consent screen to Production (or choose Internal), create an OAuth client ID of type Web
   application with the callback URL the page shows, and paste its client ID and secret. An app
   left in Testing stops connecting after 7 days.
2. On a self-hosted Direx, a server app just for Search Console:
   `bun apps/api/src/secrets.ts set social_app.google_search_console`, with
   `client_id:client_secret` on stdin.
3. On a self-hosted Direx, the Google sign-in app: `DIREX_GOOGLE_CLIENT_ID` and the
   `signin.google` secret, with the Search Console API turned on for that client.

With none of these, a member is told to ask an Owner or Admin. When a server app is set, an Owner
or Admin can still use the Workspace's own app instead. Adding or removing a Workspace's own app
asks everyone who connected Search Console in that Workspace to reconnect, because Google ties a
connection to the app it was made with. Direx links to the API's page in Google Cloud when the API
is off.

If Google stops accepting the connection, the page says "Search Console needs reconnecting" with a
Reconnect button.

## What Direx reads

Direx reads search data for the one property you chose, and no other. It reads it when the page
asks for it and doesn't store it.

The SEO page shows:

- Clicks and impressions for the last 28 days of data. Search Console runs a few days behind, so
  that window ends 3 days ago.
- **Near page one**: searches where one of your pages sits at positions 8 to 20, with 20 or more
  impressions.
- **Slipping**: pages whose impressions fell by 30% or more against the 28 days before, from at
  least 200 impressions, with each page's top search now.
- **Competing pages**: searches where two or more of your pages each get 10 or more impressions.

Each list shows its top 5 and counts the rest. Searches for your own brand are left out, using the
Workspace name and the site's domain.

## Weekly Briefs

Each Monday Direx picks up to 3 pages from those lists, taking from each list in turn, and writes a
Brief for each. A page that had a Brief approved or dismissed in the last 28 days, or has one still
open, is skipped. An Admin or Owner can press "Write this week's Briefs now" to start the week's run
early. Each week runs once. A run that started no Brief can be run again 10 minutes after it began.

For each page, Direx reads it from your site first. It checks robots.txt before reading, and skips a
page it isn't allowed to read, isn't a web page or is too big. The SEO page lists any page it
skipped and why.

Briefs need a model. On a self-hosted Direx, connect Claude Code or Codex under Models. On Direx
Cloud they aren't available yet.

## Reading and approving a Brief

A Brief waits for you in Home. It shows why the page was picked, with Search Console's numbers, then
up to 6 gaps. Each gap has the page's own words, the fix and how to see it's live. "Did it help" is
always the same check: this search on this page, 28 days after the change against the 28 days
before.

Before a Brief reaches you, Direx checks that every quote is really on the page it read. A Brief
that quotes words that aren't there is never shown. If the page tried to give the agent
instructions, the Brief says so and that they weren't followed.

Approving a Brief means you'll make the change yourself. Direx keeps the approved Brief, and
doesn't change the page or publish anything. "Copy as Markdown" copies the Brief to paste wherever
the change gets made.

## A Brief for one page in a Campaign

A Campaign step can ask for a Brief on a page you name. This needs a self-hosted Direx for now.

1. In the Campaign, open the Drafts tab.
2. On the step, open "Change setup", set Type to "SEO brief for one page" and save.
3. Enter the Page and the Search, then press "Make brief". If the step waits for another step, its
   page is the link from that step.
4. The Brief waits in Needs you. Approving it publishes nothing.
5. Once it's approved, make the changes as a WordPress draft and give its link on the step.

A step's Brief doesn't count toward the week's 3.
