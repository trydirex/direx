# Gaps a page can have for one search

Each gap has a label. Start the Gap cell with the label, a colon, then plain words, for example
`title: the query isn't in the title`. Use only these six labels. If what you see fits none of
them, leave it out.

For every gap, quote the page in "The page says": the exact words, copied, not paraphrased. When
the gap is that something is missing, quote what is there instead, or write "nothing on the page".

## `intent`: the page is the wrong kind of page for the search

Read what the search asks for from its words alone. You don't see search results, so don't
describe them.

| The search reads like | The person wants |
|---|---|
| "what is", "meaning", "definition", a bare term | A definition near the top, then an explanation |
| "how to", "steps", "template", "example", "format" | Steps, a template or a worked example |
| "best", "top", "vs", "alternatives", "compared" | A comparison of several options with how they differ |
| "price", "pricing", "buy", "software", "tool", "service" | A product or service page that says what it costs and how to start |
| A place name, "near me" | A page about that place |

Page kinds: a landing page, an article, a product page, a service page, a comparison, a local page,
a tool. Quote the H1 and the section headings as evidence. When the page kind doesn't match, list
this gap first: no other fix helps much while it stands.

**Is it live:** the new H1 and headings are on the published page.

## `title`: the search's words are missing from the title, H1 or opening

Check the `<title>`, the H1 and the first paragraph. Close forms count ("reconcile" for
"reconciliation"). Quote all three as they are.

**Is it live:** the new title is in the page source and the new H1 is on the page.

## `unanswered`: the question in the search isn't answered

If the search asks something ("what is a gl reconciliation", "how often should you reconcile"),
look for a passage that answers it in one or two sentences. Quote the closest passage, or write
"nothing on the page".

**Is it live:** the answer is on the page, near the top of its section.

## `dated`: the page shows its age

An old year in the title or text, "new in" a version that's long past, a price, product or law
named as current that the page itself contradicts. Quote the dated words. Don't decide from memory
that a product or price is gone; only a date or a contradiction on the page counts.

**Is it live:** the dated words are gone or changed, and any "updated" date on the page is new.

## `meta`: the meta description is missing, off topic or templated

Quote the `<meta name="description">` content, or write "none". Off topic: it doesn't mention
what the search asks about. Templated: it repeats the title and then adds a stock line ("Learn
more today!", "Contact us now") that reads as if it was generated for every page.

**Is it live:** the new description is in the page source.

## `buried`: the answer is there but hard to reach

The page answers the search, but low down, under an unrelated heading, or split across sections so
no single passage answers it. Quote where it sits and the heading above it.

**Is it live:** the answer sits in its own section with a heading that uses the search's words.

## Every gap: did it help

The same for all six: "In Search Console, filter to this query and this page, and compare average
position and clicks for the 28 days after the change with the 28 days before." Never promise that
it will help.

## Not gaps

Don't report these: word count on its own, a score of any kind, keyword density, backlinks,
speed, anything you'd need another page or search results to see, and anything only true of other
sites.
