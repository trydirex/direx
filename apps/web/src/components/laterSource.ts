// SPDX-License-Identifier: AGPL-3.0-only
// Where Input.tsx gets its number, date, time and file fields. Only the route file may import() lazily,
// so it hands over the loader here; this file imports nothing, so the first page stays light.
import type * as Later from "./laterFields";

export type LaterFields = typeof Later;
let source: (() => Promise<LaterFields>) | undefined;
let fields: LaterFields | undefined;
let pending: Promise<LaterFields> | undefined;

/** How to load the later fields: the route file's import(), or a test's static one. */
export const provideFields = (load: () => Promise<LaterFields>) => {
  source = load;
};
/** Loads the later fields now, once. */
export const loadFields = () => (pending ??= source!().then((m) => (fields = m)));
/** The later fields once loaded, so a field renders at once from then on. */
export const loadedFields = () => fields;
