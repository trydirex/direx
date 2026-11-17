// SPDX-License-Identifier: AGPL-3.0-only
// The seo module's only public entry point: a Workspace's Search Console property and its search data,
// and the weekly Briefs made from it.
export { createSeo, type Property, type Refused, type Row, type SearchRefusal, type Seo } from "./application/search-console";
export { briefSink, createBriefs, seoKinds, stepBriefState, weekOf, type Briefs, type BriefStep, type RunNote, type StartBrief, type StepBriefState } from "./application/briefs";
export { createPageReader, pageParts } from "./application/read-page";
export { pagesWorthABrief, seoAskStarts } from "./application/ask-starts";
export { BRIEF_LIMITS, briefMarkdown, briefProblems, norm, type Brief } from "./domain/brief";
export { BRIEF_OUTPUT_KEY, pageBrief, seoDefinitions } from "./definitions/page-brief";
export { seoRoutes } from "./routes";
