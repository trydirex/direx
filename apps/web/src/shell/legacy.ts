// SPDX-License-Identifier: AGPL-3.0-only
// Old links were query strings on "/" (/?workspace=ID&page=campaigns&campaign=C). Emails already
// sent and the API's connect callback still use them, so they redirect for good.

/** The new path for an old query-string URL, or null when the search isn't an old link. */
export function legacyPath(search: string, firstWorkspace?: string): string | null {
  const q = new URLSearchParams(search);
  if (q.get("reset") === "password") return withQuery("/reset-password", pick(q, "token"));
  if (q.get("new") === "org") return "/new-org";
  const workspace = q.get("workspace") ?? firstWorkspace;
  const page = q.get("page");
  if (!q.has("workspace") && page === null) return null;
  if (!workspace) return null;
  const [path, keep] = route(page, q);
  return withQuery(`/w/${workspace}${path}`, keep);
}

function route(page: string | null, q: URLSearchParams): [string, URLSearchParams] {
  const id = (key: string) => encodeURIComponent(q.get(key)!);
  const rest = (...keys: string[]) => pick(q, ...keys);
  switch (page) {
    case "calendar":
      return ["/calendar", rest()];
    case "campaigns":
      if (q.has("campaign")) return [`/campaigns/${id("campaign")}`, rest("tab")];
      if (q.has("plan")) return [`/plans/${id("plan")}`, rest("run", "notice")];
      return ["/campaigns", rest()];
    case "rules":
      return ["/settings/rules", rest("campaign", "step", "mode")];
    case "lessons":
      return ["/brand/lessons", rest()];
    case "brand":
      return ["/brand", rest()];
    case "models":
      return ["/settings/models", rest()];
    case "credentials":
      return ["/settings/credentials", rest("connect_error", "connect_code", "connected")];
    case "social":
      return ["/settings/social", rest("connect_error", "connect_code", "connected")];
    case "members":
      return ["/settings/members", rest()];
    case "prospecting":
      return q.has("run") ? [`/people/find/${id("run")}`, rest()] : ["/people/find", rest()];
    case "cohorts":
      if (q.has("handover")) return [`/people/handovers/${id("handover")}`, rest()];
      if (q.has("cohort")) return [`/people/cohorts/${id("cohort")}`, rest()];
      return ["/people/cohorts", rest()];
    case "outreach":
      return ["/people", rest()];
    case "newsletter":
      return q.has("issue") ? [`/newsletter/${id("issue")}`, rest()] : ["/newsletter", rest()];
    case "seo":
      return ["/seo", rest("connect_error", "connect_code", "connected")];
    default:
      return ["", rest()];
  }
}

// The router reads each search value as JSON when it parses, so connect_code=190 would arrive as a
// number. A value that parses is quoted, the router's own form for a string, and arrives as written.
const parses = (v: string) => {
  try {
    JSON.parse(v);
    return true;
  } catch {
    return false;
  }
};

function pick(q: URLSearchParams, ...keys: string[]) {
  const out = new URLSearchParams();
  for (const k of keys) if (q.has(k)) out.set(k, parses(q.get(k)!) ? JSON.stringify(q.get(k)) : q.get(k)!);
  return out;
}
const withQuery = (path: string, q: URLSearchParams) => (q.size ? `${path}?${q}` : path);
