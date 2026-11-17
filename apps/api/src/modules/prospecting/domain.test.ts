// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { classify, decodeEntities, extractAddresses, leftOutBecause, pageText, type FoundAddress } from "./domain/addresses";
import { companyDomain, domainOf, firmName, onCompanyDomain } from "./domain/domains";
import { doNotEmailNotice } from "./domain/notice";
import { sharedMailDomain } from "../people/index";

test("a company domain is the same however its site is written", () => {
  for (const v of ["acme.com", "https://www.Acme.com/contact?x=1", "http://acme.com:8080/", " WWW.ACME.COM. ", "acme.com/about#team"]) {
    expect(companyDomain(v, sharedMailDomain)).toBe("acme.com");
  }
  expect(companyDomain("https://uk.acme.co.uk/about", sharedMailDomain)).toBe("uk.acme.co.uk");
  expect(companyDomain("gmailstudio.com", sharedMailDomain)).toBe("gmailstudio.com");
});

test("a value that names no company's site has no company domain", () => {
  for (const v of ["", "  ", "ftp://acme.com", "mailto:jane@acme.com", "javascript:alert(1)", "localhost", "http://10.0.0.1/", "https://[::1]/", "0x7f.0.0.1", "gmail.com", "https://mail.yahoo.com", "http://exa mple.com"]) {
    expect(companyDomain(v, sharedMailDomain)).toBeNull();
  }
});

test("an address is on the company's domain or one of its subdomains, nothing else", () => {
  expect(domainOf("Jane@Mail.Acme.com")).toBe("mail.acme.com");
  expect(onCompanyDomain("jane@acme.com", "acme.com")).toBe(true);
  expect(onCompanyDomain("jane@mail.acme.com", "acme.com")).toBe(true);
  expect(onCompanyDomain("jane@notacme.com", "acme.com")).toBe(false);
  expect(onCompanyDomain("jane@acme.com.evil.io", "acme.com")).toBe(false);
  expect(onCompanyDomain("acme.com", "acme.com")).toBe(false);
});

test("an address only in a mailto: link is found, without its subject or escapes", () => {
  const html = `<a href="mailto:Jane.Doe@acme.com?subject=Hi%20there&amp;cc=boss@acme.com">Write to us</a>
    <a href='mailto:sam%40acme.com,lee@acme.com'>Sam</a>`;
  expect(extractAddresses(html).sort()).toEqual(["boss@acme.com", "jane.doe@acme.com", "lee@acme.com", "sam@acme.com"]);
});

test("addresses hidden with entities, Cloudflare or [at] and [dot] are found", () => {
  const cf = (email: string, key = 0x42) => key.toString(16).padStart(2, "0") + [...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
  const html = `
    <p>jennie&#103;&#64;acme&#46;com</p>
    <p>tom&commat;acme&period;com and ann&#x40;acme.com</p>
    <a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${cf("jennieg@acme.com")}">[email&#160;protected]</a>
    <a href="/cdn-cgi/l/email-protection#${cf("sales@acme.com", 0x1f)}">Sales</a>
    <p>bob [at] acme [dot] com, carl (at) acme (dot) co (dot) uk, dee{at}acme.com</p>`;
  expect(extractAddresses(html).sort()).toEqual(
    ["ann@acme.com", "bob@acme.com", "carl@acme.co.uk", "dee@acme.com", "jennieg@acme.com", "sales@acme.com", "tom@acme.com"].sort(),
  );
});

test("things that only look like addresses are not found", () => {
  const html = `<img src="/logo@2x.png"><img srcset="hero@3x.webp 3x"><link href="x@1.css">
    <p>Meet us at Acme dot com events.</p><p>@acme on social</p><p>[email protected]</p>
    <p>Price: 3 at 4.00</p><a href="mailto:">empty</a><div data-cfemail="zz"></div>`;
  expect(extractAddresses(html)).toEqual([]);
  expect(extractAddresses(`<p>...jane..@acme.com.</p>`)).toEqual(["jane@acme.com"]);
});

test("a long run of letters with no address is scanned quickly", () => {
  const started = performance.now();
  expect(extractAddresses(`<img src="data:image/png;base64,${"A".repeat(400_000)}">`)).toEqual([]);
  expect(performance.now() - started).toBeLessThan(2000);
});

test("entities decode, and malformed ones stay as written", () => {
  expect(decodeEntities("a&#64;b &#x2E; &amp; &unknown; &#0; &#99999999;")).toBe("a@b . & &unknown; &#0; &#99999999;");
  expect(pageText("<style>p{}</style><p>Hi&nbsp;there</p><script>var x='a@b.com'</script><p>Bye</p>")).toBe("Hi there\nBye");
});

const people = [
  { first: "Jennie", last: "Garcia" },
  { first: "José", last: "O'Neil" },
];

test("an address is named when its local part is a known person's name pattern", () => {
  for (const email of ["jennie@acme.com", "jennie.garcia@acme.com", "jennie_garcia@acme.com", "jenniegarcia@acme.com", "jgarcia@acme.com", "j.garcia@acme.com", "jennieg@acme.com", "Jennie+news@acme.com"]) {
    expect(classify(email, people)).toEqual({ kind: "named", name: people[0] });
  }
  expect(classify("jose.oneil@acme.com", people)).toEqual({ kind: "named", name: people[1] });
  expect(classify("jose@acme.com", people)).toEqual({ kind: "named", name: people[1] });
});

test("near misses of a name are not named", () => {
  for (const email of ["jen@acme.com", "garcia.jennie@acme.com", "jenniegar@acme.com", "jennie2@acme.com", "kgarcia@acme.com"]) {
    expect(classify(email, people)).toEqual({ kind: "unknown" });
  }
  expect(classify("jennie@acme.com", [])).toEqual({ kind: "unknown" });
  expect(classify("jennie@acme.com", [{ first: "", last: "Jennie" }])).toEqual({ kind: "unknown" });
  expect(classify("ann@acme.com", [{ first: "Ann", last: "" }])).toEqual({ kind: "named", name: { first: "Ann", last: "" } });
});

test("function and generic addresses follow the short lists", () => {
  for (const local of ["sales", "partnerships", "marketing", "growth", "founders", "hello", "Sales"]) {
    expect(classify(`${local}@acme.com`, [])).toEqual({ kind: "function" });
  }
  for (const local of ["info", "support", "admin", "careers", "press", "billing", "noreply", "no-reply", "do-not-reply", "contactus", "info2", "office.info", "hr", "postmaster", "team"]) {
    expect(classify(`${local}@acme.com`, [])).toEqual({ kind: "generic" });
  }
  // Near misses: a function word with more added, or a name that contains a generic-looking word.
  for (const local of ["salesforce-admin2x", "marketingteam", "hello.world", "infante"]) {
    expect(classify(`${local}@acme.com`, []).kind).not.toBe("function");
  }
  expect(classify("infante@acme.com", [])).toEqual({ kind: "unknown" });
  expect(classify("sales@acme.com", [{ first: "Sales", last: "" }])).toEqual({ kind: "named", name: { first: "Sales", last: "" } });
});

const found = (over: Partial<FoundAddress> = {}): FoundAddress => ({ email: "jennie@acme.com", kind: "named", noticeFound: false, ...over });

test("every address left out has a stated reason", () => {
  expect(leftOutBecause(found(), "acme.com")).toBeNull();
  expect(leftOutBecause(found({ email: "jennie@uk.acme.com", kind: "function" }), "acme.com")).toBeNull();
  expect(leftOutBecause(found({ kind: "unknown" }), "acme.com")).toBeNull();
  expect(leftOutBecause(found({ email: "jennie@gmail.com" }), "acme.com")).toBe("other_domain");
  expect(leftOutBecause(found({ email: "jennie@acme.co" }), "acme.com")).toBe("other_domain");
  expect(leftOutBecause(found({ noticeFound: true }), "acme.com")).toBe("do_not_email_notice");
  expect(leftOutBecause(found({ email: "info@acme.com", kind: "generic" }), "acme.com")).toBe("generic_address");
  expect(leftOutBecause(found({ email: "info@other.com", kind: "generic", noticeFound: true }), "acme.com")).toBe("other_domain");
});

test("a page telling senders not to market to its addresses blocks them", () => {
  const blocks = [
    "<footer>Please do not send us unsolicited email.</footer>",
    "<p>Don’t email us marketing offers.</p>",
    "<p>Do not send marketing emails to this address.</p>",
    "<p>Do NOT send sales pitches to the addresses on this page.</p>",
    "<p>This e-mail address is not to be used for unsolicited commercial email.</p>",
    "<p>Email addresses on this website may not be used for solicitation purposes.</p>",
    "<p>We do not accept unsolicited sales emails or calls.</p>",
    "<p>Contact</p><p>No unsolicited emails, please.</p>",
    "<p>Contact us. No marketing solicitations.</p>",
    "<p>Unsolicited commercial email is not welcome.</p>",
    "<p>We do not consent to receive commercial electronic messages.</p>",
    "<p>Please&nbsp;do&nbsp;not send us <b>unsolicited</b> email.</p>",
  ];
  for (const html of blocks) expect(doNotEmailNotice(html), html).not.toBeNull();
  expect(doNotEmailNotice("<p>Please do not send us unsolicited email.</p>")).toBe("do not send us unsolicited");
});

test("near misses, such as an article about do-not-email practice, don't block", () => {
  const allows = [
    "<h1>Why every sales team needs a do not email list</h1><p>Do not email prospects who opted out.</p>",
    "<p>Do not send marketing emails to people who have unsubscribed. It hurts your reputation.</p>",
    "<p>Some sites say \"please do not send us unsolicited email\" in their footer.</p>",
    "<p>A footer reading ‘no unsolicited emails’ is common.</p>",
    "<p>We send no marketing emails, only receipts.</p>",
    "<p>Never miss an update: sign up for our marketing emails.</p>",
    "<p>Our marketing email platform helps you send more.</p>",
    "<p>Do not send us original documents by post.</p>",
    "<p>Email us at sales@acme.com for a quote.</p>",
    "<script>var t='Please do not send us unsolicited email'</script><p>Welcome</p>",
    "",
  ];
  for (const html of allows) expect(doNotEmailNotice(html), html).toBeNull();
});

test("a firm's name is the part of a search title that names the firm, or nothing when no part does", () => {
  const cases: [string, string, string | null][] = [
    ["Certified QuickBooks Online ProAdvisor | Harbor Business Solutions", "harborbusinesssolutions.test", "Harbor Business Solutions"],
    ["Lakeside, WI Accounting Firm | Home Page | Small Business Accounting Solutions, LLC", "sbasgroup.test", "Small Business Accounting Solutions, LLC"],
    ["Certified QuickBooks ProAdvisor® – Brannock, Hale & Fields, LLC", "brannockcpa.test", "Brannock, Hale & Fields, LLC"],
    ["Home - Erin Hale CPA", "erinhcpa.test", "Erin Hale CPA"],
    ["Acme", "acme.test", "Acme"],
    ["QuickBooks Accounting Support | Riverton | Oakdale CT", "easthillcpa.test", null],
    ["Lakeside QuickBooks Support Services | Certified ProAdvisor | Lakeside", "tristatecpa.test", null],
    ["QUICKBOOKS ONLINE CONSULTING AND ACCOUNTING", "jrlightfootcpa.test", null],
    ["", "acme.test", null],
  ];
  for (const [title, domain, name] of cases) expect(firmName(title, domain), title).toBe(name);
});
