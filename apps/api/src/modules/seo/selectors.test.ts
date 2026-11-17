// SPDX-License-Identifier: AGPL-3.0-only
// The three selectors at each threshold's edge, the brand filter, ranking and the cap.
import { describe, expect, test } from "vitest";
import { brandTerms, competing, isBrand, nearPageOne, slipping, type SearchRow } from "./domain/selectors";

const qp = (query: string, page: string, impressions: number, position = 12, clicks = 0): SearchRow => ({ keys: [query, page], clicks, impressions, position });
const pg = (page: string, impressions: number): SearchRow => ({ keys: [page], clicks: 0, impressions, position: 10 });
const terms = brandTerms("Contoso", "sc-domain:contosohq.example");

describe("brand", () => {
  test("terms are the Workspace name and the property's domain label, lower-cased without spaces", () => {
    expect(terms).toEqual(["contoso", "contosohq"]);
    expect(brandTerms("Acme Books", "https://www.acme-books.co.uk/")).toEqual(["acmebooks", "acme-books"]);
    expect(brandTerms("Ab", "https://ab.io/")).toEqual([]);
  });

  test("a query naming the brand, with or without spaces, or a site: search is brand", () => {
    for (const q of ["contoso pricing", "Contoso HQ", "contoso hq login", "site:contosohq.example"]) expect(isBrand(q, terms)).toBe(true);
    for (const q of ["bank reconciliation", "quality equity"]) expect(isBrand(q, terms)).toBe(false);
  });
});

describe("near page one", () => {
  test("keeps positions 8 to 20 inclusive with 20 or more impressions, and leaves out brand", () => {
    const rows = [qp("a", "/p", 50, 7.9), qp("b", "/p", 50, 8), qp("c", "/p", 50, 20), qp("d", "/p", 50, 20.1), qp("e", "/p", 19, 10), qp("f", "/p", 20, 10), qp("contoso app", "/p", 500, 10)];
    expect(nearPageOne(rows, terms).top.map((c) => c.query).sort()).toEqual(["b", "c", "f"]);
  });

  test("ranks by impressions, caps at 20 and reports the total", () => {
    const rows = Array.from({ length: 25 }, (_, i) => qp(`q${i}`, "/p", 20 + i, 10, i));
    const r = nearPageOne(rows, terms);
    expect(r.total).toBe(25);
    expect(r.top).toHaveLength(20);
    expect(r.top[0]).toEqual({ query: "q24", page: "/p", clicks: 24, impressions: 44, position: 10 });
  });
});

describe("slipping", () => {
  const queries = [qp("q a", "/a", 5), qp("q b", "/b", 5), qp("q c", "/c", 5), qp("q d", "/d", 5), qp("q gone", "/gone", 0), qp("q e", "/e", 9), qp("q e2", "/e", 3)];

  test("needs 200 or more before and at most 70% of it now; a page missing now counts as 0", () => {
    const before = [pg("/a", 199), pg("/b", 200), pg("/c", 1000), pg("/d", 1000), pg("/gone", 400)];
    const now = [pg("/a", 0), pg("/b", 140), pg("/c", 700), pg("/d", 701)];
    const r = slipping(now, before, queries, terms);
    expect(r.top.map((c) => c.page)).toEqual(["/gone", "/c", "/b"]);
    expect(r.top[0]).toEqual({ page: "/gone", query: "q gone", impressionsBefore: 400, impressionsNow: 0 });
  });

  test("attaches the page's top non-brand query, and drops a page that has none", () => {
    const rows = [...queries, qp("contoso review", "/e", 99), qp("contoso", "/brand-only", 50)];
    const r = slipping([], [pg("/e", 500), pg("/brand-only", 500)], rows, terms);
    expect(r.top).toEqual([{ page: "/e", query: "q e", impressionsBefore: 500, impressionsNow: 0 }]);
  });

  test("ranks by impressions lost", () => {
    const r = slipping([pg("/a", 100), pg("/b", 0)], [pg("/a", 1000), pg("/b", 300)], queries, terms);
    expect(r.top.map((c) => c.page)).toEqual(["/a", "/b"]);
  });
});

describe("competing", () => {
  test("needs 2 or more pages with 10 or more impressions each, and leaves out brand", () => {
    const rows = [qp("x", "/1", 10), qp("x", "/2", 30, 9), qp("y", "/1", 10), qp("y", "/2", 9), qp("contoso", "/1", 99), qp("contoso", "/2", 99)];
    expect(competing(rows, terms)).toEqual({
      total: 1,
      top: [{ query: "x", impressions: 40, pages: [{ page: "/2", clicks: 0, impressions: 30, position: 9 }, { page: "/1", clicks: 0, impressions: 10, position: 12 }] }],
    });
  });

  test("ranks queries by impressions over their pages", () => {
    const rows = [qp("small", "/1", 10), qp("small", "/2", 10), qp("big", "/1", 50), qp("big", "/2", 50), qp("big", "/3", 50)];
    expect(competing(rows, terms).top.map((c) => [c.query, c.pages.length])).toEqual([["big", 3], ["small", 2]]);
  });
});
