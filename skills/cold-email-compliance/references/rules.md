# Rules a cold email is checked against

Each rule is `pass`, `fail` or `can't tell`. Judge the email as you were given it: if something
a rule needs is missing from it, that's `fail`, even if a sending tool might add it later. Say so
in What to fix. Use `can't tell` only for what the text of an email can't show, such as the From
and Reply-To headers, and say what to confirm.

These come from the research in `countries.json` (read 2026-10-30). "Not read" means the research
didn't reach that part of the law. It doesn't mean there is no rule.

| Rule | Passes when | Where the research found it |
|---|---|---|
| Opt-out | Every email has a clear, working way to stop: a link, or a line saying a reply stops them. It must be free and simple | US, CA, GB, AU, NZ, FR (objection), FI (free refusal with each email) |
| Sender identity | The email says who is sending: the person and the business, not hidden or invented | US, CA, GB, AU, NZ, FI. FR from memory, not read |
| Contact address | A way to reach the sender. The US asks for a valid physical postal address; the UK for a valid address to opt out to; Canada for contact information | US, GB, CA |
| Honest subject | The subject isn't misleading about the email, and doesn't pretend to be a reply or a forward when it isn't one | US. The reply and forward test applies everywhere |
| Honest headers | From and Reply-To name the real sender accurately | US, AU |
| Ad identification | A US email is identifiable as an advertisement or solicitation | US only |

## Reply and forward prefixes

A first email whose subject starts with one of these, in any case, with or without brackets,
fails Honest subject: `Re:`, `Fw:`, `Fwd:`, `AW:`, `WG:`, `SV:`, `VS:`, `RV:`, `TR:`, `Antw:`,
`Réf:`, `Ref:`.

## How fast an opt-out must work

| Country | Deadline | Source |
|---|---|---|
| US | 10 business days. The mechanism must keep working for 30 days after sending | https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business |
| CA | 10 business days | https://laws-lois.justice.gc.ca/eng/acts/E-1.6/FullText.html |
| AU | 5 business days | https://www.legislation.gov.au/C2004A01214/asmade/2003-12-12/text/original/pdf |
| GB | None stated | https://www.legislation.gov.uk/uksi/2003/2426/regulation/22 |
| NZ, FR, IE, FI | Not read | See `countries.json` |

## The sender's country

Canada's law (CASL) also covers email sent from Canada, wherever it goes, and it has no
legitimate-interest basis. If the sender is in Canada, say so, whatever the recipient's country.
