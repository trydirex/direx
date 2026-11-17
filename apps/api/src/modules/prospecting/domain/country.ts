// SPDX-License-Identifier: AGPL-3.0-only
// A company's country is recorded only from a postal address on its own site, quoted from the page. A
// domain ending isn't proof, and neither is a sentence that merely names a country, so a line has to
// look like part of an address: a street, a unit, or a postal code.

export type Country = { code: string; quote: string };

// Codes Intl still names that are retired, reserved or not countries.
const NOT_COUNTRIES = new Set("AC AN BU CP CQ CS DD DG DY EA EU EZ FX HV IC NH QO RH SU TA TP UK UN VD XA XB YD YU ZR ZZ".split(" "));
const ALIASES: Record<string, string> = {
  "united states of america": "US",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  "hong kong": "HK",
  macau: "MO",
  turkey: "TR",
  "czech republic": "CZ",
  "ivory coast": "CI",
  myanmar: "MM",
  "the netherlands": "NL",
  holland: "NL",
  "republic of ireland": "IE",
};
// Upper case only, so "us" in "contact us" isn't the United States.
const ABBREVIATIONS: Record<string, string> = { USA: "US", "U.S.A.": "US", "U.S.": "US", UK: "GB", "U.K.": "GB", UAE: "AE" };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function countryNames(): Map<string, string> {
  const names = new Map(Object.entries(ALIASES));
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      const name = NOT_COUNTRIES.has(code) ? undefined : display.of(code);
      if (!name || name === code) continue;
      for (const spelling of [name, name.replace(/ & /g, " and "), name.replace(/^St\. /, "Saint ")]) names.set(spelling.toLowerCase(), code);
    }
  }
  // Also a US state, which is far likelier on a firm's site.
  names.delete("georgia");
  return names;
}

const NAMES = countryNames();
// Longest first, so "South Sudan" wins over "Sudan".
const byLength = (list: Iterable<string>) => [...list].sort((x, y) => y.length - x.length).map(escape).join("|");
// Not after "New", so New Mexico and New Jersey aren't Mexico and Jersey.
const NAME_AT_END = new RegExp(`(?:^|[,\\s])(?<!\\bnew\\s)(${byLength(NAMES.keys())})\\.?$`, "i");
const ABBREVIATION_AT_END = new RegExp(`(?:^|[,\\s])(${byLength(Object.keys(ABBREVIATIONS))})$`);

const STREET_WORDS = "Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Place|Pl|Court|Ct|Square|Sq|Parkway|Pkwy|Highway|Hwy|Crescent|Cres|Terrace|Row";
const ADDRESS_HINTS = [
  // 12 King Street West
  new RegExp(String.raw`\b\d{1,5}[A-Za-z]?,?\s+(?:[A-Z][\w'’.-]*\s+){0,4}(?:${STREET_WORDS})\b`),
  // Hauptstraße 5, Keizersgracht 123
  /[A-Za-zÀ-ÿ]+(?:straße|strasse|gasse|weg|platz|laan|straat|gracht|vej|gatan|katu)\s+\d+/i,
  // 12 rue de la Paix, Via Roma 5
  /\b\d+,?\s+(?:rue|avenue|boulevard|via|calle|avenida|piazza|plaza)\b|\b(?:rue|via|calle|avenida|piazza)\s+[^,\n]{1,40}?\s\d+/i,
  /\b(?:Suite|Unit|Floor|Ste|P\.?\s?O\.?\s+Box)\b\.?\s*#?\d+/i,
  // 10115 Berlin, 1012 AB Amsterdam, EC1A 1BB
  /\b\d{4,5}\s+[A-Z][a-zà-ÿ]+|\b\d{4}\s?[A-Z]{2}\b|\b[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}\b/,
];
const US_STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".replace(/ /g, "|");
const PROVINCES = "AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT";
// A state or province with its postal code is an address on its own, without the country written out.
const POSTAL: [RegExp, string][] = [
  [new RegExp(String.raw`\b(?:${US_STATES})\s+\d{5}(?:-\d{4})?\b`), "US"],
  [new RegExp(String.raw`\b(?:${PROVINCES})\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d\b`), "CA"],
];
// An address is a few short lines; a country at the end of a paragraph is prose.
const MAX_LINE = 120;
const LINES_BEFORE = 3;

/** The first postal address in the pages' text, with the lines that show it. */
export function countryFrom(texts: readonly string[]): Country | null {
  for (const text of texts) {
    const lines = text.split("\n").map((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > MAX_LINE) continue;
      const named = NAME_AT_END.exec(line);
      const abbreviated = ABBREVIATION_AT_END.exec(line);
      const code = named ? NAMES.get(named[1]!.toLowerCase()) : abbreviated ? ABBREVIATIONS[abbreviated[1]!] : undefined;
      if (code) {
        const window = lines.slice(Math.max(0, i - LINES_BEFORE), i + 1);
        if (window.every((l) => l.length <= MAX_LINE) && ADDRESS_HINTS.some((h) => window.some((l) => h.test(l)))) {
          // Only from the first line that is part of the address, so the quote is the address and not the menu above it.
          const first = window.findIndex((l) => ADDRESS_HINTS.some((h) => h.test(l)));
          return { code, quote: window.slice(first).join("\n") };
        }
      }
      for (const [pattern, country] of POSTAL) if (pattern.test(line)) return { code: country, quote: line };
    }
  }
  return null;
}
