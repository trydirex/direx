# Saved government pages

These five files are copies of public pages and API answers from government publishers, cut to
at most 16 KB. The country watch (`scripts/country-watch.ts`) fetches the same addresses each week
and opens an issue when one changes; `test/country-watch.test.ts` reads these copies so the tests
never touch the network.

They are not Direx's work and are not covered by the AGPL in the root `LICENSE`. Each belongs to
its publisher, on the terms the publisher sets. The addresses come from
`skills/cold-email-compliance/references/countries.json`.

| File | Publisher | Fetched from | The publisher's reuse terms |
|---|---|---|---|
| `au.json` | Federal Register of Legislation, Australia | `https://api.prod.legislation.gov.au/v1/Versions/Find(titleId='C2004A01214',asAtSpecification='Latest')` | https://www.legislation.gov.au/copyright |
| `ca.html` | Justice Laws Website, Government of Canada | https://laws-lois.justice.gc.ca/eng/acts/E-1.6/ | The Reproduction of Federal Law Order: https://laws-lois.justice.gc.ca/eng/regulations/SI-97-5/page-1.html |
| `fi.xml` | Finlex, Ministry of Justice, Finland | https://opendata.finlex.fi/finlex/avoindata/v1/akn/fi/act/statute-consolidated/2014/917 | https://www.finlex.fi/en/open-data |
| `gb.xml` | legislation.gov.uk, The National Archives | https://www.legislation.gov.uk/changes/affected/uksi/2003/2426/data.feed | Contains public sector information licensed under the Open Government Licence v3.0: https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/ |
| `us.json` | Federal Register, United States | The `federalregister.gov` documents API, for 16 CFR 316 | https://www.federalregister.gov/reader-aids/policy/legal-status |

None of these copies is an official text. Read the law at the publisher's address.
