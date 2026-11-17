// SPDX-License-Identifier: AGPL-3.0-only
// The interfaces a separately installed package can fill. Core calls only these and never names
// such a package, and with nothing installed each one refuses or does nothing.

/** Raised on any change to a type here, so a package built against another shape can refuse to start. */
export const EXTENSIONS_VERSION = 1;

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
