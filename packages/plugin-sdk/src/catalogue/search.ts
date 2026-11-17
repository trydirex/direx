// SPDX-License-Identifier: MIT
// A search data source: the properties an account can see, and search analytics rows for one. Date
// bounds a provider keeps, such as how far back it reaches, are its own and checked by its plugin.
import { z } from "zod";
import { noInput } from "./entry";

export const SEARCH_DIMENSIONS = ["query", "page", "date", "country", "device"] as const;

export const searchProperties = {
  name: "search.properties",
  version: 1,
  input: noInput,
  output: z.array(z.strictObject({ siteUrl: z.string(), permissionLevel: z.string() })),
} as const;

export const searchAnalytics = {
  name: "search.analytics",
  version: 1,
  // The caller pages with startRow; a page shorter than rowLimit is the last.
  input: z.strictObject({
    siteUrl: z.string().min(1).max(2048),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    dimensions: z.array(z.enum(SEARCH_DIMENSIONS)).min(1).refine((d) => new Set(d).size === d.length, "each dimension once"),
    rowLimit: z.number().int().min(1).max(25_000).optional(),
    startRow: z.number().int().min(0).optional(),
  }),
  output: z.strictObject({
    rows: z.array(z.strictObject({ keys: z.array(z.string()), clicks: z.number(), impressions: z.number(), ctr: z.number(), position: z.number() })),
  }),
} as const;
