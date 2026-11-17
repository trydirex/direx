// SPDX-License-Identifier: AGPL-3.0-only
// Core reads: read tools agents can be given over their own Workspace's Items, schedule and
// Campaigns. The composition root hands them to agents, which never imports items or campaigns.
export { coreReaders as createCoreReads, doorReads, warningsOf, type Disclosure, type DoorRead, type DoorReadName, type DoorReadResult, type Reader, type ReadResult, type StartSources, type Trust } from "./application/readers";
