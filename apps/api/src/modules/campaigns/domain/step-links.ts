// SPDX-License-Identifier: AGPL-3.0-only
// Step links: one step waiting on another step's output, a URL. One level deep, inside one Campaign,
// and only manual, post and SEO brief steps produce an output.

export type LinkedStep = { stepKey: string; type: string; dependsOnStepKey: string | null };

export type DependencyRefusal = "dependency_not_found" | "dependency_self" | "dependency_depth" | "no_output";

const PRODUCES_OUTPUT = new Set(["manual", "post", "seo_brief"]);

/** Whether step `key` may wait on step `dependsOn`, given every step of the Campaign. */
export function checkDependency(steps: readonly LinkedStep[], key: string, dependsOn: string): { ok: true } | { ok: false; reason: DependencyRefusal } {
  if (dependsOn === key) return { ok: false, reason: "dependency_self" };
  const target = steps.find((s) => s.stepKey === dependsOn);
  if (!target) return { ok: false, reason: "dependency_not_found" };
  if (target.dependsOnStepKey !== null || steps.some((s) => s.dependsOnStepKey === key)) return { ok: false, reason: "dependency_depth" };
  return PRODUCES_OUTPUT.has(target.type) ? { ok: true } : { ok: false, reason: "no_output" };
}

export const MAX_URL_LENGTH = 2048;

/** A URL a person or a provider gave as a step's output: https only, no credentials, at most 2,048 characters. */
export function checkOutputUrl(raw: string): { ok: true; url: string } | { ok: false; reason: "bad_url" } {
  const text = raw.trim();
  if (!text || text.length > MAX_URL_LENGTH || !URL.canParse(text)) return { ok: false, reason: "bad_url" };
  const url = new URL(text);
  if (url.protocol !== "https:" || url.username || url.password) return { ok: false, reason: "bad_url" };
  return url.href.length > MAX_URL_LENGTH ? { ok: false, reason: "bad_url" } : { ok: true, url: url.href };
}

const withoutUtm = (url: URL): URL => {
  const copy = new URL(url.href);
  for (const name of [...copy.searchParams.keys()]) if (name.toLowerCase().startsWith("utm_")) copy.searchParams.delete(name);
  return copy;
};

export type UtmTags = { medium: string; campaign: string; content: string };

/** The URL with the four Direx tags, keeping other parameters and replacing any existing utm_ ones. */
export function withUtm(href: string, tags: UtmTags): string {
  const url = withoutUtm(new URL(href));
  url.searchParams.set("utm_source", "direx");
  url.searchParams.set("utm_medium", tags.medium);
  url.searchParams.set("utm_campaign", tags.campaign);
  url.searchParams.set("utm_content", tags.content);
  return url.href;
}

/** Whether two URLs are the same page once utm_ parameters are ignored. */
export function sameIgnoringUtm(a: string, b: string): boolean {
  if (!URL.canParse(a) || !URL.canParse(b)) return false;
  return withoutUtm(new URL(a)).href === withoutUtm(new URL(b)).href;
}
