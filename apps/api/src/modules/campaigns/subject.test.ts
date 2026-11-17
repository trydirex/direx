// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { replyPrefix } from "./domain/subject";

test.each(["Re: your audit", "RE: RE: audit", "Fwd: audit", "FW: audit", "[Fwd]: audit", "(re) : audit", "AW: Angebot", "WG: Angebot", "SV: tilbud", "TR: devis", "RÉF: devis", "Antw: offerte", "Re： audit", "  re:audit"])(
  "%s looks like a reply or forward",
  (subject) => {
    expect(replyPrefix(subject)).toBe(true);
  },
);

test.each(["Regarding your audit", "Rework plan", "Fwd thinking for retailers", "A question about re: pricing", "Trial for Acme", "Svelte stores"])("%s is a first email", (subject) => {
  expect(replyPrefix(subject)).toBe(false);
});
