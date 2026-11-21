// SPDX-License-Identifier: AGPL-3.0-only
// The tracking module's only public entry point (ADR 0035): a Workspace's tracking domains, and the
// edge's question about them, served on an internal port, links rewritten in a step's email, and the
// public redirect that counts their clicks.
export { systemDns, type DnsLookup } from "./adapters/dns";
export { createTrackingDomains, type TrackingDomains } from "./application/domains";
export { fixLinks, recordUses, type FixedLinks, type TrackingInput } from "./application/links";
export { createRedirect, type Redirect } from "./application/redirect";
export { trackingAskApp, trackingRedirectApp, trackingRoutes } from "./routes";
