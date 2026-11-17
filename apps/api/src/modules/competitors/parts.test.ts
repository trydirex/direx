// SPDX-License-Identifier: AGPL-3.0-only
// The parts kept from each source, on small pages modelled on r64 §7 (not copies of competitor pages).
import { expect, test } from "vitest";
import { pageParts } from "../seo/index";
import { partsOf } from "./application/parts";
import { blocks, isRelativeTime } from "./domain/parts";

const read = (html: string) => ({ html, ...pageParts(html) });

// A Canny-style changelog: weekly entries, real changes inside a "General improvements" list.
const changelog = `<html><head><title>Changelog | Double</title></head><body>
<header><div class="cookie">We use cookies. Accept</div></header>
<nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
<article><h2>November 5, 2026</h2><span>3 days ago</span>
  <p>Match and split bank-feed transactions with Ask Double.</p>
  <h3>General improvements</h3>
  <ul><li>Bank reconciliation now auto-matches transfers between accounts</li><li>Faster   exports &amp; filters</li></ul>
</article>
<article><h2>October 29, 2026</h2><span>yesterday</span><p>Autoclose: AI agents reconcile accounts.</p>
  <ul><li>Faster exports &amp; filters</li></ul></article>
<script>window.x = "Not a line"</script>
<footer><p>© 2026 Double</p></footer></body></html>`;

test("a changelog keeps every line, a line inside a list as its own (E7), without frame, scripts, times or repeats", () => {
  const { lines } = partsOf("changelog", read(changelog)) as { lines: string[] };
  expect(lines).toEqual([
    "November 5, 2026",
    "Match and split bank-feed transactions with Ask Double.",
    "General improvements",
    "Bank reconciliation now auto-matches transfers between accounts",
    "Faster exports & filters",
    "October 29, 2026",
    "Autoclose: AI agents reconcile accounts.",
  ]);
});

const pricing = `<html><head><title>Pricing</title></head><body>
<h1>Simple pricing</h1><p>Plans for every firm.</p>
<div class="card"><h3>Core</h3><div>$10 per client / month</div><ul><li>Up to 50 clients</li><li>Bank feeds</li></ul></div>
<div class="card"><h3>Enterprise</h3><div>Contact sales</div></div>
<p>Questions? Talk to us.</p></body></html>`;

test("a pricing page keeps headings and lines with a digit: plan names, prices and limits", () => {
  expect(partsOf("pricing", read(pricing))).toEqual({ lines: ["Simple pricing", "Core", "$10 per client / month", "Up to 50 clients", "Enterprise"] });
});

// Double's home page in r64: SVG sprites carry their own <title>s, and the hero sits inside <header>.
const landing = `<html><head><title>Double: The Fully Automated Close is Here</title>
<meta name="description" content="Close the books faster."></head><body>
<svg><symbol><title>envelope-o</title></symbol><symbol><title>star</title></symbol></svg>
<nav><p>Solutions</p></nav>
<header class="hero"><h1>Your fully automated close is here.</h1><p>AI agents reconcile every account.</p></header>
<section><h2>Trusted by 2,000 firms</h2></section></body></html>`;

test("a landing page keeps the head's title and description, the headline and the subhead", () => {
  expect(partsOf("landing", read(landing))).toEqual({
    title: "Double: The Fully Automated Close is Here",
    description: "Close the books faster.",
    headline: "Your fully automated close is here.",
    subhead: "AI agents reconcile every account.",
  });
});

test("live-page cases: a heading broken by <br>, a script cut off by the read cap, numeric character codes", () => {
  // Double's and Finlens's real headlines (2026-11-11).
  const hero = `<h1 class="h1">Your fully&nbsp;<br>automated<br>close is here.<br></h1><p>Add more clients without<br />adding headcount.</p>`;
  expect(partsOf("landing", read(hero))).toMatchObject({ headline: "Your fully automated close is here.", subhead: "Add more clients without" });
  // Canny's inline state, cut by the 200 KB cap before </script>.
  const cut = `<article><p>Bank feeds ready for Canada</p></article><script>window.__data = {"a":"<p>not a line</p>"`;
  expect(partsOf("changelog", read(cut))).toEqual({ lines: ["Bank feeds ready for Canada"] });
  expect(partsOf("changelog", read("<p>Close &#x2715; It&#8217;s here &#0;</p>"))).toEqual({ lines: ["Close ✕ It’s here"] });
});

test("a landing page with no h1 has no headline or subhead", () => {
  expect(partsOf("landing", read("<p>Just text</p>"))).toEqual({ title: null, description: null, headline: null, subhead: null });
});

test("blocks are named by the tag that opens them; a closing tag starts an unnamed one", () => {
  expect(blocks("a<p>b</p>c<br>d").map((b) => [b.tag, b.html])).toEqual([
    ["", "a"],
    ["p", "b"],
    ["", "c"],
    ["br", "d"],
  ]);
});

test.each([
  ["3 days ago", true],
  ["an hour ago", true],
  [" Yesterday ", true],
  ["just now", true],
  ["Released 3 days ago with fixes", false],
  ["30 days free", false],
])("isRelativeTime(%j) is %s", (line, is) => {
  expect(isRelativeTime(line)).toBe(is);
});
