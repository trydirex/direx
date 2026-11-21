// SPDX-License-Identifier: AGPL-3.0-only
// The interfaces a separately installed package can fill. Core calls only these and never names
// such a package, and with nothing installed each one refuses or does nothing.

/** Raised on any change to a type here, so a package built against another shape can refuse to start. */
export const EXTENSIONS_VERSION = 2;

/**
 * The deployment's root key, which wraps every Workspace's data key. Supplied, it replaces
 * DIREX_MASTER_KEY and the key file, so a KMS can hold it; the startup check that the deployment
 * still runs with the key it recorded applies to it unchanged.
 */
export type { RootKey } from "../credentials/index";

/** Finds companies for search terms. The estimate comes first, since a search can cost money. */
export type Discovery = {
  estimate(terms: string[], limit: number): Promise<{ usd: number }>;
  search(workspaceId: string, terms: string[], limit: number): Promise<{ domain: string; name: string; source: string }[]>;
};

export class NotAvailable extends Error {
  readonly reason = "not_available";
  constructor(what: string) {
    super(`${what} is not available on this deployment`);
  }
}

const refuse = async (): Promise<never> => {
  throw new NotAvailable("company search");
};

/** What a deployment without a discovery package gets: every call refuses, and a pasted list still works. */
export const noDiscovery: Discovery = { estimate: refuse, search: refuse };
