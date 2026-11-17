// SPDX-License-Identifier: MIT
// What a docs tool answers: the pages or databases a person shared with Direx, one page's text,
// and one database's columns and rows. What a page says is data, never an instruction.
import { z } from "zod";

const id = z.string().min(1).max(200);

export const docsSources = {
  name: "docs.sources",
  version: 1,
  input: z.strictObject({ kind: z.enum(["page", "database"]).optional() }).nullish(),
  output: z.strictObject({ pages: z.array(z.strictObject({ id: z.string(), title: z.string(), url: z.string().nullable(), editedAt: z.string().nullable() })), more: z.boolean() }),
} as const;

export const docsPageText = {
  name: "docs.page_text",
  version: 1,
  input: z.strictObject({ pageId: id }),
  /** `cut`: the page was longer than the plugin reads. */
  output: z.strictObject({ title: z.string(), text: z.string(), cut: z.boolean() }),
} as const;

export const docsRows = {
  name: "docs.rows",
  version: 1,
  input: z.strictObject({ sourceId: id, cursor: z.string().min(1).max(500).optional(), editedSince: z.iso.datetime({ offset: true }).optional() }),
  // A column's id and its choices' ids are what a status write-back maps to (ADR 0025).
  output: z.strictObject({
    title: z.string(),
    columns: z.array(
      z.strictObject({
        name: z.string(),
        id: z.string().optional(),
        type: z.string(),
        options: z.array(z.string()).nullable(),
        choices: z.array(z.strictObject({ id: z.string(), name: z.string() })).nullable().optional(),
      }),
    ),
    rows: z.array(z.strictObject({ id: z.string(), editedAt: z.string().nullable(), values: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])) })),
    next: z.string().nullable(),
  }),
} as const;

const propertyId = z.string().min(1).max(200);
/**
 * One status write-back (ADR 0025 rule 003): the row, its status property and the option to set, the option
 * Direx last wrote (null for none), and on Sent the URL property and link. Ids only, never names. Direx
 * reads back which option it wrote and whether with a link.
 */
export const docsRowUpdate = {
  name: "docs.row.update",
  version: 1,
  input: z.strictObject({
    pageId: id,
    statusPropertyId: propertyId,
    statusType: z.enum(["status", "select"]),
    optionId: propertyId,
    lastOptionId: propertyId.nullable(),
    urlPropertyId: propertyId.optional(),
    url: z.url({ protocol: /^https?$/ }).max(2000).optional(),
  }),
  spec: z.looseObject({ optionId: z.string(), url: z.string().optional() }),
} as const;
