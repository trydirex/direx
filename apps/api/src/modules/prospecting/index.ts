// SPDX-License-Identifier: AGPL-3.0-only
// The prospecting module's only entry point.
export { COMPANY_READ_QUEUE, COMPANY_VERIFY_QUEUE, workCompanyReads, workCompanyVerifies, type CompanyRead } from "./adapters/queue";
export { createVerifier, verifyThrough, VERIFIED_FOR_DAYS, type VerifyAddress, type VerifyQuery } from "./application/verify";
export { createCompanyReader } from "./application/read-company";
export { namesEnded, namesSink, type NamesInput, type StartNames } from "./application/names";
export { NAMES_OUTPUT_KEY, namesReader, prospectingDefinitions, type NamesOutput } from "./definitions/names-reader";
export { prospectingAskStarts } from "./application/ask-starts";
export { createTerms, termsSink, type ReadStrategy, type StartTerms, type Terms } from "./application/terms";
export { TERMS_OUTPUT_KEY, termsDrafter } from "./definitions/terms-drafter";
export { holdsPersonData, keptTerms, termsText } from "./domain/terms";
// The names a search term must not hold, for any module that sends terms to a search vendor.
export { knownNames } from "./adapters/terms-repo";
export { keptPeople, namesText, type NamedPerson } from "./domain/people";
export { createRuns, ESTIMATE_DEFAULTS, MAX_COMPANIES, type Estimate, type PastedLine, type Runs, type SearchLine } from "./application/runs";
export { prospectingRoutes } from "./routes";
export { companyReviews, prospectKinds, REJECTED_KEEP_DAYS, REVIEW_KIND, REVIEW_WARNING, type ReviewPayload } from "./application/review";
export { createCohorts, type Cohort, type CohortMember, type Cohorts } from "./application/cohorts";
export { HANDOVER_QUEUE, workHandovers } from "./adapters/queue";
export { addressLabelsFor, createHandovers, keptEligibility, signalsFor, type Handovers } from "./application/handover";
