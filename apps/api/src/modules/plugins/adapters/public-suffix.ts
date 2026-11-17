// SPDX-License-Identifier: AGPL-3.0-only
// The Public Suffix List, ICANN and PRIVATE sections, through tldts. A wildcard egress host on one of
// these (`*.co.uk`, `*.workers.dev`) would reach strangers' sites, so the installer refuses it.
import { getPublicSuffix } from "tldts";

/** True when the name is itself a public suffix. An unknown top-level name counts as one. */
export const isPublicSuffix = (name: string): boolean => getPublicSuffix(name, { allowPrivateDomains: true }) === name.toLowerCase();
