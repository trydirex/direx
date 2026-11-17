// SPDX-License-Identifier: AGPL-3.0-only
// An SEO brief step: one page and one search. The page is typed, or is the output of the step this
// one waits on, never both.
import { checkOutputUrl } from "./step-links";

export type BriefSetup = { page: string | null; query: string };
export type BriefSetupRefusal = "bad_url" | "bad_query" | "page_and_dependency";

export function checkBriefSetup(s: { page: string | null; query: string; dependsOn: string | null }): { ok: true; setup: BriefSetup } | { ok: false; reason: BriefSetupRefusal } {
  const query = s.query.trim();
  if (query.length < 2 || query.length > 200) return { ok: false, reason: "bad_query" };
  if (s.dependsOn !== null) return s.page === null ? { ok: true, setup: { page: null, query } } : { ok: false, reason: "page_and_dependency" };
  const page = s.page === null ? null : checkOutputUrl(s.page);
  return page?.ok ? { ok: true, setup: { page: page.url, query } } : { ok: false, reason: "bad_url" };
}
