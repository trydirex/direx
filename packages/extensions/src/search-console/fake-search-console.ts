// SPDX-License-Identifier: AGPL-3.0-only
// A fake Search Console API v3 for tests, answering with Google's shapes. Pass `fetch` to the
// plugin. `failNext(kind)` makes the next calls answer as Google does when the token is revoked
// (401), the account can't see the property (403), the API is off in the OAuth client's project
// (403), or the quota is used up (429). Analytics rows are served from `startRow`, `rowLimit` at a time.
export type FakeSearchConsoleSite = { siteUrl: string; permissionLevel: string };
export type FakeSearchConsoleRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
export type FakeSearchConsoleFailure = "revoked" | "no_access" | "api_disabled" | "rate_limited";

const PROJECT = "123456789012";

export function createFakeSearchConsole(o: { token?: string; sites?: FakeSearchConsoleSite[]; rows?: FakeSearchConsoleRow[] } = {}) {
  const token = o.token ?? "search-console-test-token";
  const sites = [...(o.sites ?? [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }])];
  const rows = [...(o.rows ?? [])];
  const calls: { method: string; path: string; body: unknown }[] = [];
  const failures: FakeSearchConsoleFailure[] = [];

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const googleError = (code: number, status: string, message: string, details: unknown[] = []) => json(code, { error: { code, message, status, ...(details.length && { details }) } });

  function fail(kind: FakeSearchConsoleFailure, siteUrl: string): Response {
    if (kind === "revoked") return googleError(401, "UNAUTHENTICATED", "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.");
    if (kind === "no_access") return googleError(403, "PERMISSION_DENIED", `User does not have sufficient permission for site '${siteUrl}'. See also: https://support.google.com/webmasters/answer/2451999.`);
    if (kind === "rate_limited") return googleError(429, "RESOURCE_EXHAUSTED", "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'.");
    return googleError(
      403,
      "PERMISSION_DENIED",
      `Google Search Console API has not been used in project ${PROJECT} before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=${PROJECT} then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.`,
      [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com", metadata: { service: "searchconsole.googleapis.com", consumer: `projects/${PROJECT}` } }],
    );
  }

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/webmasters\/v3/, "");
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    const query = path.match(/^\/sites\/([^/]+)\/searchAnalytics\/query$/);
    const siteUrl = query ? decodeURIComponent(query[1]!) : "";
    const failure = failures.shift();
    if (failure) return fail(failure, siteUrl);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${token}`) return fail("revoked", siteUrl);

    if (method === "GET" && path === "/sites") return json(200, sites.length ? { siteEntry: sites } : {});
    if (method === "POST" && query) {
      if (!sites.some((s) => s.siteUrl === siteUrl)) return fail("no_access", siteUrl);
      const b = body as { rowLimit?: number; startRow?: number };
      const start = b.startRow ?? 0;
      const page = rows.slice(start, start + (b.rowLimit ?? 1000));
      // Google leaves `rows` out when there are none.
      return json(200, page.length ? { rows: page, responseAggregationType: "byProperty" } : { responseAggregationType: "byProperty" });
    }
    return googleError(404, "NOT_FOUND", "Not Found");
  }) as typeof globalThis.fetch;

  return { fetch, token, calls, sites, rows, failNext: (kind: FakeSearchConsoleFailure, times = 1) => void failures.push(...Array<FakeSearchConsoleFailure>(times).fill(kind)) };
}
