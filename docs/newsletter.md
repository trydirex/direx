# Newsletter

Direx sets up one weekly newsletter issue for each Workspace. You write it, someone approves it,
and only then does it go out to your list. An issue nobody approves in time is skipped, never sent.

## Choosing a tool

Direx sends through Kit or beehiiv with your API key. Substack has no connection: you write and
approve the issue in Direx, then copy it into Substack and send it there.

Only an Owner or Admin can set this up. Everyone else sees the day, time and list, and "Only an
Admin or Owner can change this."

1. Open Campaigns, then Newsletter.
2. Under "Newsletter tool", pick your tool.
3. If it isn't connected yet, paste its API key and click "Connect" with the tool's name. Direx
   checks the key with the tool, then keeps it encrypted in this Workspace's Credentials, where you
   can replace or remove it later.
4. If the account holds several lists, pick one under "Which (tool) list gets the newsletter". Each shows
   its subscriber count. No issue is made until you choose. An account with one list needs no
   choice.
5. Set Day, Time and Time zone, keep "Send a weekly issue" ticked, and click Save.

The page then says when the next issue goes out and to which list. If it has been more than a month
since the last issue, it warns you to expect a few more unsubscribes.

## Writing an issue

Two days before each issue's time, at 06:00 in your time zone, Direx adds that week's issue to Home
as an empty draft.

1. On Home, click "Write and preview it".
2. Fill in Title, Preview text (optional) and "Issue, in Markdown".
3. Check the preview, which shows exactly what your list receives. Paragraphs, headings, lists,
   bold, italic and links work. HTML and images don't come through.
4. Click Save, then "Send for approval".

## Approving

Someone who can approve clicks "Approve" on the issue. For an issue Direx sends, the button also
says when it goes out.

- Editing an approved issue takes the approval back, so it needs approving again.
- Some tools are handed the issue a few minutes early. The page then says "Approve by" a time so it
  can go out on time.
- If nobody approves before the issue's time, Direx cancels it and Home says "This week's issue was
  skipped".

The approved issue names its list, so choosing another list later changes the next issue, not this
one.

## Sending by hand

On Substack, and on a tool that refuses to send through Direx on your plan, each issue is a
copy-and-paste handoff. You write and approve it the same way, and approving sends nothing.

1. After approval, the issue page shows "Copy this into" with the tool's name.
2. Click "Copy HTML", paste it into the tool and send it there.
3. Click "I sent it". Direx records it as this week's send.

If beehiiv refuses to send because the account isn't on Pro, the Newsletter page says "Read-only:
needs beehiiv Pro", and the refused issue comes back as a handoff to approve and send by hand. Every
issue stays a handoff until you replace the key in Credentials.

## After the send

Direx reads what the tool reports 30 minutes, 1 hour, 1 day and 7 days after an issue goes out, and
shows it under "After the send": how many people it went to, deliveries where the tool reports them,
clicks and unsubscribes. Opens are shown too, but mail apps open many emails automatically, so they
count more than really read it.

If the tool reports no deliveries after 30 minutes while the list has subscribers, the issue warns
that the tool accepted it but hasn't emailed anyone yet.

Direx gets no numbers for an issue you sent by hand. Check them in the tool.

## Unsubscribes

Your newsletter tool sends each issue to its list, and Direx adds no unsubscribe link of its own.
Unsubscribes happen in the tool, and Direx shows their count after each send.

Direx also reads the addresses on a connected list and keeps them. Anyone who was ever on the list
stays recorded, even after they unsubscribe. A cold email to one of them waits, and Direx asks
whether to send it anyway.

## Cloud and self-hosted

The newsletter works the same way on Direx cloud and self-hosted. The API key is always your
Workspace's own.
