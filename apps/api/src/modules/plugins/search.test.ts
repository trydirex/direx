// SPDX-License-Identifier: AGPL-3.0-only
// Core finds a search data provider from its manifest, whichever plugin it is.
import { firstPartyPlugins } from "@direx/extensions";
import { parseManifest } from "@direx/plugin-sdk";
import { expect, test } from "vitest";
import { searchConnections } from "./application/search";
import { CallFailed, failureOf, searchProviders } from "./index";

const manifest = (capabilities: { name: string; connection: string }[]) => {
  const r = parseManifest({
    id: "com.example.search",
    apiVersion: 1,
    version: "0.1.0",
    minHostVersion: "0.1.0",
    trust: "first_party",
    connections: [{ key: "a", auth: "oauth2" }, { key: "b", auth: "oauth2" }],
    egress: { hosts: ["api.example.com"] },
    capabilities: capabilities.map((c) => ({ kind: "query", ...c })),
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.manifest;
};

test("a connection with both search queries is a provider; queries split across connections are not", () => {
  const m = manifest([
    { name: "search.properties", connection: "b" },
    { name: "search.analytics", connection: "b" },
  ]);
  expect(searchConnections(m)).toEqual(["b"]);
  expect(searchProviders([m])).toEqual([{ connection: "b", properties: "com.example.search/search.properties", analytics: "com.example.search/search.analytics" }]);
  const split = manifest([
    { name: "search.properties", connection: "a" },
    { name: "search.analytics", connection: "b" },
  ]);
  expect(searchConnections(split)).toEqual([]);
  expect(searchProviders([split])).toEqual([]);
});

test("Search Console is the first-party provider", () => {
  expect(searchProviders(firstPartyPlugins().map((p) => p.manifest))).toEqual([
    { connection: "google_search_console", properties: "com.trydirex.search-console/search.properties", analytics: "com.trydirex.search-console/search.analytics" },
  ]);
});

test("a plugin's failure is read from its typed fields, and a code only where the query lists it", () => {
  expect(failureOf(new CallFailed("plugin error: anything", { reason: "rate_limited", status: 429, waitMs: 60_000 }), "search.analytics")).toEqual({ reason: "rate_limited", status: 429, waitMs: 60_000 });
  expect(failureOf(new CallFailed("x", { reason: "provider_error", status: 403, code: "api_disabled" }), "com.trydirex.search-console/search.analytics")).toEqual({ reason: "provider_error", status: 403, code: "api_disabled" });
  expect(failureOf(new CallFailed("x", { reason: "provider_error", code: "api_disabled" }), "newsletter.subscribers")).toEqual({ reason: "provider_error" });
  expect(failureOf(new Error("Search Console answered 401: needs_reconnecting"))).toEqual({ reason: "failed" });
});
