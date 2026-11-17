// SPDX-License-Identifier: AGPL-3.0-only
// The module's parts put together, apart from index.ts so routes can name the type.
import type { Items } from "../../items";
import { factWrites } from "./facts";
import { proposals } from "./proposals";
import { factReads } from "./reads";
import { voice, type Generate } from "./voice";

/** `generate` and `checkOpen` serve the Voice check; left out, as in most tests, pasting a Voice example stays closed. */
export function createFacts(deps: { items: () => Items; now?: () => Date; generate?: () => Generate | undefined; checkOpen?: () => boolean }) {
  const now = deps.now ?? (() => new Date());
  return { ...factReads(), ...factWrites({ now }), ...proposals({ items: deps.items }), ...voice({ now, generate: deps.generate, checkOpen: deps.checkOpen }) };
}
export type Facts = ReturnType<typeof createFacts>;
