// SPDX-License-Identifier: AGPL-3.0-only
// The tracking module's only public entry point (ADR 0035): a Workspace's tracking domains, and the
// edge's question about them, served on an internal port.
export { systemDns, type DnsLookup } from "./adapters/dns";
export { createTrackingDomains, type TrackingDomains } from "./application/domains";
export { trackingAskApp, trackingRoutes } from "./routes";
