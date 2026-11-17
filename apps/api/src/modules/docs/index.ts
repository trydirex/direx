// SPDX-License-Identifier: AGPL-3.0-only
// A docs tool (Notion first): pages read for brand facts, a database imported to the Calendar, and
// each imported row's status written back under a recorded yes (spec P1 to P3, ADR 0025).
export { createDocs, type Docs } from "./application/docs";
export type { DocsProvider } from "./application/read";
export { docsRoutes, docsWriteBackRoutes } from "./routes";
export { createWriteBackGrants, DOC_WRITE_GRANT_KIND, DOCS_WRITE_WORDING, DOCS_WRITE_WORDING_VERSION, docWriteCurrent, docWriteGrantVersion, isDocsWrite, type WriteBackGrants, type WriteBackState } from "./application/grant";
export { createWriteBack, HELD_FOR_MS, type WriteBackSweep } from "./application/write-back";
