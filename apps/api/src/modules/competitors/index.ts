// SPDX-License-Identifier: AGPL-3.0-only
// Competitor watch (Beta): the competitors a Workspace names and the pages Direx reads for each one.
export { createCompetitors, type Competitor, type Competitors, type ReadPage } from "./application/competitors";
export { createSnapshots, type Snapshots } from "./application/snapshots";
export { createProposals as createCompetitorProposals, type Proposals as CompetitorProposals, type WorkspaceSite } from "./application/proposals";
export { createLabels, type Labels } from "./application/labels";
export { createMoves, type Moves } from "./application/moves";
export { competitorKinds } from "./application/kinds";
export { changeClassifier, competitorDefinitions, COMPETITOR_CHANGE_PURPOSE, LABELS_OUTPUT_KEY } from "./definitions/change-classifier";
export { comparisonBrief, COMPARISON_BRIEF_PURPOSE, COMPARISON_OUTPUT_KEY } from "./definitions/comparison-brief";
export { counterPost, COUNTER_POST_PURPOSE, POST_OUTPUT_KEY } from "./definitions/counter-post";
export { competitorRoutes } from "./routes";
export { MAX_COMPETITORS, SOURCES, type Source } from "./domain/competitor";
