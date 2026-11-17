// SPDX-License-Identifier: AGPL-3.0-only
// Placement checks: a Mailbox's yes, its stop, the live checks every placement Action passes, and
// the routing that keeps placement mail away from outreach.
// The placement module's only public entry point.
export { createPlacement, GRANT_KIND, isPlacementCapability, PLACEMENT_WORDING, PLACEMENT_WORDING_VERSION, placementGranted, placementGrantVersion, stopOnAccountLimit, type Placement, type PlacementState } from "./application/grant";
export { routePlacement, type MatchInbound } from "./application/route";
export { placementRoutes } from "./routes";
export { createJoin, type JoinFor, type MemberKeys, type PlacementJoin } from "./application/join";
export { JOIN_SUBJECT, joinSigned, joinText, parseJoin, type Join, type SignedJoin } from "./domain/join";
export { CONTENT_TEST_WORDING_VERSION, contentTestVersion, contentTestWording, createContentTests, type ContentTests, type ContentYes } from "./application/content-tests";
export { contentProbe, plainProbe, plainSubject, type Probe, type Sender } from "./application/render";
export { contentSubject, expectedAt, matchWindow, pairDay, probeIdentity, receiversFor, RECEIVERS_PER_DAY, seed, sendersTo, WINDOW_AFTER_MINUTES, WINDOW_BEFORE_MINUTES, type PairMember, type ProbeIdentity, type ProbeKind, type Seed } from "./application/pairing";
export { googleMx, type ResolveMx } from "./application/mx";
export { contentHash, pinnedRootHash, rootChainHash, trustList, verifyList, type TrustedList, type Verdict } from "./application/list";
export { canonical, unsigned } from "./domain/canonical";
export type { Criteria, Member, MemberList, UnsignedList } from "./domain/list";
export { isBootstrap, PINNED_ROOT, type Root } from "./domain/root";
export { CANCEL_AFTER_MS, createSending, DAILY_CAP, NEW_MEMBER_CAP, placementSendCheck, type NotToday, type Sending } from "./application/send";
export { checksToSkip, createReading, matchExpected, READ_AFTER_MS, skipFor, verdictOf, type ArchiveRefusal, type CheckRead, type Reading } from "./application/read";
export { countReport, createReporting, dkimPasses, fromAddress, type Reporting } from "./application/reports";
export { parseReport, REPORT_ENTRIES, REPORT_SUBJECT, reportSigned, reportText, type Report, type ReportEntry } from "./domain/report";
