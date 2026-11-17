# Review time

Review time puts a block in your own calendar on the days you choose, so you set time aside to go
through what needs your approval. Each block says how much is waiting in Needs you and when the
next item is due, for example "Direx review: 7 waiting, next due Fri 21 Nov".

It is for people who can approve: Owners, Admins and Marketers.

## Setting it up

1. Go to Settings, then Review time.
2. Pick the days, the start time, how long each block lasts, and your time zone.
3. Choose Make my calendar link, and copy the link. Direx shows it only once.
4. Add it to your calendar as a subscription:
   - Google Calendar: next to Other calendars, choose the plus, then From URL.
   - Outlook: Add calendar, then Subscribe from web.
   - Apple Calendar: File, then New Calendar Subscription.

Your calendar shows the next 14 days of blocks. Changing the days or time on the same page moves
them without changing the link.

## What the link shows

Only a count, a date and a link back to Home. Never the text of a draft, who it goes to or which
Campaign it belongs to. Anyone you forward the link to sees the same thing, so treat it like a
password: if it gets out, choose Get a new link and the old one stops working at once.

The link also stops working when you choose Stop my calendar link, when your role changes to one
that can't approve, or when you leave the Workspace.

## How fresh the count is

Your calendar decides how often it checks. Google can take up to a day, so the number in a block
is as of the last check, which the description of each block states.

## Self-hosted Direx

Calendar services fetch the link from their own servers, so your Direx needs a public HTTPS
address (`DIREX_BASE_URL`). On a local or private address the page says so, and the link starts
working once the address is public.
