// SPDX-License-Identifier: AGPL-3.0-only
// The kept parts of one page read, by source: the domain's blocks with each one's HTML made text.
import { htmlToText } from "../../agents/index";
import { blocks, changelogLines, DROPPED, landingParts, pricingLines, type LandingParts, type Line } from "../domain/parts";
import type { Source } from "../domain/competitor";

export type Parts = { lines: string[] } | LandingParts;
type Read = { html: string; title: string | null; metaDescription: string | null };

const linesOf = (html: string, dropped?: readonly string[]): Line[] => blocks(html, dropped).map((b) => ({ tag: b.tag, text: htmlToText(b.html) }));

export function partsOf(source: Source, read: Read): Parts {
  if (source === "changelog") return { lines: changelogLines(linesOf(read.html)) };
  if (source === "pricing") return { lines: pricingLines(linesOf(read.html)) };
  // A landing page's hero often sits inside <header>, so only the menu and the footer are dropped.
  return landingParts(
    linesOf(
      read.html,
      DROPPED.filter((t) => t !== "header"),
    ),
    read,
  );
}
