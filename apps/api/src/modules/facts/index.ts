// SPDX-License-Identifier: AGPL-3.0-only
// Business context: what a Workspace is allowed to say about itself. Only a person makes a
// fact. factKinds is registered with items and factVersion with the ledger, so neither
// imports this module.
export { factKinds } from "./application/proposals";
export { factRoutes } from "./routes";
export { citationOf, describeFactChange, factVersion, type FactView } from "./application/reads";
export type { Citation } from "./domain/citation";
export { FIELDS, MAX_FACT_CHARS, subjectOf, type Confidence, type Field, type Source } from "./domain/slots";
export { createFacts, type Facts } from "./application/create";
export { voiceCheck } from "./definitions/voice-check";
