// SPDX-License-Identifier: AGPL-3.0-only
// The door (ADR 0032): one credential for callers outside a session, and later the readers and
// proposal intake it opens. This module's only entry point.
export { registerReaders, type Registration } from "./application/registry";
export { doorApp, DOOR_BASE } from "./routes";
export { createRequests, DEFAULT_CAPS, type Caps, type DoorOutcome, type Requests } from "./application/requests";
export { createStops, type Stopped } from "./application/stops";
export { createTokens, type CreateInput, type CreateRefusal, type Tokens, type TokenState } from "./application/tokens";
export { DOOR_KINDS, DOOR_READERS, type DoorKind, type DoorReader } from "./domain/catalogue";
export { lifetimeChoices, maxDaysFromEnv, type TokenCaller } from "./domain/tokens";
