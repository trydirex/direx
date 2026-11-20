// SPDX-License-Identifier: AGPL-3.0-only
// The competitor list: add, edit, remove, list, and a check of what each URL gives. The check
// answers the person at that moment and is not stored; a failed one never blocks the save.
import type { createPageReader } from "../../seo/index";
import { closeProposals, deleteRow, getRow, inWorkspace, insertRow, isUniqueViolation, listRows, lockList, countRows, openProposals, updateRow, type CompetitorRow, type CompetitorValues, type CompetitorsTx } from "../adapters/repo";
import { checkFields, MAX_COMPETITORS, pricesIn, SOURCES, type FieldProblem, type Source } from "../domain/competitor";
import { nameKey, siteKey } from "../domain/own-site";

export type ReadPage = ReturnType<typeof createPageReader>;
export type CheckResult = "readable" | "no_prices" | "robots_disallowed" | "not_html" | "too_big" | "failed";
/** `prices` is set on a readable pricing page: the prices found in its text. */
export type Check = { source: Source; url: string; result: CheckResult; detail?: string; prices?: string[] };
export type Competitor = Pick<CompetitorRow, "id" | "name" | "pricingUrl" | "changelogUrl" | "landingUrl" | "comparisonUrl">;
export type Input = { name: string; comparisonUrl?: string | null } & Partial<Record<`${Source}Url`, string | null>>;
/** `proposalId` is the proposal a person used to fill the form; one matching by name or site is closed too. */
export type NewInput = Input & { proposalId?: string };
type Refused = { ok: false; reason: FieldProblem | "too_many" | "name_taken" | "not_found" };
type Saved = { ok: true; competitor: Competitor; checks: Check[] };

const view = ({ id, name, pricingUrl, changelogUrl, landingUrl, comparisonUrl }: CompetitorRow): Competitor => ({ id, name, pricingUrl, changelogUrl, landingUrl, comparisonUrl });

/** A blank URL is no URL, and a name is kept without its outer spaces. */
const clean = (v: Input): CompetitorValues => {
  const url = (u: string | null | undefined) => (u?.trim() ? u.trim() : null);
  return { name: v.name.trim(), pricingUrl: url(v.pricingUrl), changelogUrl: url(v.changelogUrl), landingUrl: url(v.landingUrl), comparisonUrl: url(v.comparisonUrl) };
};

/** Closes, as added, the open proposals this new competitor answers: the one used, and any of the same name or site. */
async function closeAnswered(tx: CompetitorsTx, row: CompetitorRow, proposalId: string | undefined, by: string, at: Date) {
  const key = nameKey(row.name);
  const site = row.landingUrl && siteKey(row.landingUrl);
  const answered = (await openProposals(tx)).filter((p) => p.id === proposalId || p.nameKey === key || (site && p.site && siteKey(p.site) === site));
  await closeProposals(tx, answered.map((p) => p.id), by, "added", at);
}

export function createCompetitors(deps: { readPage: ReadPage; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());

  async function checkOne(source: Source, url: string): Promise<Check> {
    const read = await deps.readPage(url);
    if (!read.ok) return { source, url, result: read.reason, ...(read.detail && { detail: read.detail }) };
    if (source !== "pricing") return { source, url, result: "readable" };
    const prices = pricesIn(read.text);
    return prices.length === 0 ? { source, url, result: "no_prices" } : { source, url, result: "readable", prices };
  }

  /** The URLs of `row` that differ from `before` (every one, with no `before`), read in parallel. */
  const checkChanged = (row: CompetitorValues, before?: CompetitorValues) =>
    Promise.all(
      SOURCES.flatMap((s) => {
        const url = row[`${s}Url`];
        return url && url !== before?.[`${s}Url`] ? [checkOne(s, url)] : [];
      }),
    );

  async function save(write: () => Promise<CompetitorRow | Refused>, before?: CompetitorValues): Promise<Saved | Refused> {
    let row: CompetitorRow | Refused;
    try {
      row = await write();
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false, reason: "name_taken" };
      throw e;
    }
    if ("ok" in row) return row;
    return { ok: true, competitor: view(row), checks: await checkChanged(row, before) };
  }

  return {
    list: async (workspaceId: string) => (await inWorkspace(workspaceId, listRows)).map(view),

    async add(workspaceId: string, userId: string, input: NewInput): Promise<Saved | Refused> {
      const v = clean(input);
      const problem = checkFields(v);
      if (problem) return { ok: false, reason: problem };
      return save(() =>
        inWorkspace(workspaceId, async (tx) => {
          await lockList(tx, workspaceId);
          if ((await countRows(tx)) >= MAX_COMPETITORS) return { ok: false, reason: "too_many" } as const;
          const row = await insertRow(tx, workspaceId, v, userId, now());
          await closeAnswered(tx, row, input.proposalId, userId, now());
          return row;
        }),
      );
    },

    /** Fields left out keep their value; a URL sent as null or blank is cleared. */
    async edit(workspaceId: string, id: string, input: Partial<Input>): Promise<Saved | Refused> {
      const before = await inWorkspace(workspaceId, (tx) => getRow(tx, id));
      if (!before) return { ok: false, reason: "not_found" };
      const v = clean({ ...before, ...input });
      const problem = checkFields(v);
      if (problem) return { ok: false, reason: problem };
      return save(async () => (await inWorkspace(workspaceId, (tx) => updateRow(tx, id, v, now()))) ?? { ok: false, reason: "not_found" }, before);
    },

    remove: (workspaceId: string, id: string) => inWorkspace(workspaceId, (tx) => deleteRow(tx, id)),

    /** Every URL on the row, read again. */
    async check(workspaceId: string, id: string): Promise<Check[] | null> {
      const row = await inWorkspace(workspaceId, (tx) => getRow(tx, id));
      return row ? checkChanged(row) : null;
    },
  };
}
export type Competitors = ReturnType<typeof createCompetitors>;
