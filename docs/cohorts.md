# Finding companies and building Cohorts

Direx finds addresses on companies' own websites. You review every company before any of its
addresses is kept. A Cohort is a saved filter over the addresses you kept, and you add a Cohort to
a Campaign to write to the People in it. Nothing is sent from any of these screens.

## Finding companies

Open People, then "Find companies". There are two ways in.

### Paste websites

1. Paste the companies' websites into "Websites, one per line". A run takes at most 200 new
   companies.
2. Under "Signals to look for", leave the ones you want ticked.
3. Enter the "Amount you confirm, in US dollars", then press "Read these companies".

Each line says what happened to it. A company Direx already knows isn't read or charged again. A
pasted list pays no search fee. Reading names from each site uses your model, and that cost is
limited for each company, but a pasted run doesn't stop at the confirmed amount yet.

### Search from your Strategy

This only appears when a company search is installed on your Direx. Company search is a separate
package, and without one the page says so and you paste websites instead.

1. Press "Draft terms from the Strategy". This needs an approved Strategy that says who it's for.
   You can change the terms. A term that holds an address, a web address or the full name of
   someone this Workspace knows is dropped, since terms go to the search service.
2. Set the number of companies, at most 200, and the signals.
3. Press "Work out the cost". Direx shows the search fee and worst-case costs for reading names and
   checking addresses.
4. Enter the amount you confirm and press "Search and read". Direx reads companies only as far as
   that amount covers, and lists the rest as left over.

Only an Owner, Admin or Marketer can start a run. "Past runs" lists the latest 20.

## What Direx reads

For each company, Direx checks robots.txt, then reads the home page and up to 5 linked pages such
as about, team, contact, careers and blog. A site that refuses, has almost no text, or asks readers
like Direx to stay away isn't read, and the run page says why.

- **Addresses** come from the pages themselves, never from a model.
- **Names** are read by your model, and a name is kept only if it's on the pages Direx stored.
- **Signals** are found by code and always quote the page: "Hiring" when the firm says it is hiring
  or lists openings, and "Blog not updated in 6 months".
- **Country** comes from the site's text, with the words it came from.

Some addresses are left out and can't be kept: one on another domain, a shared inbox such as info@
or support@, one no one on the site is known by, and any address on a site that asks not to be sent
marketing email. So is one for a Person who opted out or was already written to.

## Reviewing a company

Each company becomes a review in Needs you, marked as read from a site Direx doesn't trust. Above
its signals, the review shows who your Strategy says you're for and its personas, so you can judge
fit against them. Check each address and quote, then:

- tick the addresses to keep and press "Accept and keep N addresses", or
- press "Reject this company". Its pages are kept for 90 days, then may be deleted.

An address that belongs to an existing Person joins them instead of making a new one.

After you accept, Direx checks each kept address with the address-checking service your Workspace
connected. For up to 2 people named on the site with no published address, it guesses `first@`,
then `first.last@`, at the company's domain. A guess is kept only if the check says it's
deliverable. Direx never guesses for a company in Canada, or on a site that asks not to be emailed.
Without a checking service, addresses show "Couldn't be checked" and nothing is guessed.

If the site names people but publishes no address for them, you can accept with nothing ticked:
the button reads "Accept and guess addresses for N people".

## Building a Cohort

1. Open People, then Cohorts.
2. Under "New cohort", give it a Name.
3. Tick what to match under Signals, "Kind of address", "Where the address came from" and "Check
   result", and enter Countries as two-letter codes such as US, GB. Leave a group empty to match
   any.
4. Press "Save cohort".

A Cohort only ever matches kept addresses at companies you accepted. It holds the filter, not a
list, so it grows as you keep more companies. Its page shows how many addresses it matches now and
where each was found.

## Adding a Cohort to a Campaign

1. Open the Cohort.
2. Under "Add to Campaign", choose the Campaign.
3. Press the "Add ... to the Campaign" button.

Direx adds who the Cohort matches at that moment, in the background, and shows what happened to
each address:

- Only an address that checks deliverable goes over. A check older than 30 days, or one that
  couldn't be done, is done again first.
- A guessed address never goes over for anyone in Canada.
- People on your Do not contact list, People already written to, and anyone removed from that
  Campaign earlier are skipped.
- A Person already in another live Campaign waits for you to decide in Review.

Each Person goes over with where the address came from and its check. A published address is
recorded as one, and a guessed one as legitimate interest. When no country is known, the Person
gets no draft until someone enters it.

## Sending

Adding People to a Campaign sends nothing. The Campaign drafts their emails, and every draft waits
for approval, unless an Owner has set up auto-approve for that step. Approved emails go out from a
Mailbox you connected. See [Connecting a Mailbox with a password](mailboxes.md) for how sending,
replies and opt-outs work.

### Reviewing many emails

A step that writes one email per address starts from the step's email. The writer keeps its
sentences and adds or changes at most two, for that person. In Needs you, the words written for
the person are highlighted and the step's own words are dimmed, so you read what changed. Each
detail the email uses about them shows its quote and a link to the page it came from. J and K move
through the queue, A approves, E edits and S skips.

When you make the same edit in three drafts of a step, the step offers it as a note: press "Add to
the notes", change it if you like, then "Save notes". New drafts follow the Writer notes. To apply
them to drafts already written, press "Rewrite the drafts nobody approved". It says how many drafts
and the most the rewrite could cost before anything starts, and each rewritten draft waits for
approval again.

If you start approving much faster while changing much less than you did before, Needs you asks
whether you're still reading each one. Only you see it, and it blocks nothing.
