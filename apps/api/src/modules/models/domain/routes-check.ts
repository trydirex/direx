// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what makes route config unfit to boot, as named reasons.
import type { Deployment } from "./budget";
import type { Price } from "./cost";

export const PROVIDERS = ["anthropic", "openai", "google", "openrouter"] as const;
export const CLI_PROVIDERS = ["claude_code", "codex"] as const;
export type CliProvider = (typeof CLI_PROVIDERS)[number];
export type Provider = (typeof PROVIDERS)[number] | CliProvider;
export const isCliProvider = (p: Provider): p is CliProvider => (CLI_PROVIDERS as readonly Provider[]).includes(p);

export type Candidate = {
  provider: Provider;
  model: string;
  maxOutputTokens: number;
  /** Null means unpriced. */
  price: Price | null;
  /** Where the recorded passing eval is; null means none. */
  evalRef: string | null;
  /** The provider's page stating this id never changes, for an id with no date in it. */
  pinSource?: string;
};

export type Route = { candidates: readonly Candidate[]; stepDown?: readonly Candidate[] };

export const SAFETY_PURPOSES: ReadonlySet<string> = new Set(["claim_check", "optout_detect", "injection_check", "lesson_check", "voice_check"]);
/** No agent output comes from this purpose, so no eval covers it. */
export const CONNECTION_TEST = "connection_test";

const CONTRACTED: ReadonlySet<Provider> = new Set(["anthropic", "openai", "google"]);

export const isPinned = (c: Pick<Candidate, "model" | "pinSource">): boolean =>
  /-(\d{8}|\d{4}-\d{2}-\d{2})$/.test(c.model) || Boolean(c.pinSource);

export type RouteIssue = {
  purpose: string;
  reason:
    | "no_candidates"
    | "uncontracted_provider"
    | "unpinned"
    | "no_price"
    | "no_eval"
    | "safety_unpinned"
    | "safety_no_eval"
    | "safety_step_down"
    | "step_down_no_eval";
  model?: string;
};

export function checkRoutes(deployment: Deployment, routes: Readonly<Record<string, Route>>): RouteIssue[] {
  const issues: RouteIssue[] = [];
  for (const [purpose, route] of Object.entries(routes)) {
    const add = (reason: RouteIssue["reason"], model?: string) => issues.push({ purpose, reason, model });
    const stepDown = route.stepDown ?? [];
    if (route.candidates.length === 0) add("no_candidates");

    if (SAFETY_PURPOSES.has(purpose)) {
      if (stepDown.length > 0) add("safety_step_down");
      for (const c of route.candidates) {
        if (!isPinned(c)) add("safety_unpinned", c.model);
        if (!c.evalRef) add("safety_no_eval", c.model);
      }
    }

    if (deployment === "cloud") {
      for (const c of [...route.candidates, ...stepDown]) {
        if (!CONTRACTED.has(c.provider)) add("uncontracted_provider", c.model);
        if (!isPinned(c)) add("unpinned", c.model);
        if (!c.price) add("no_price", c.model);
      }
      if (purpose !== CONNECTION_TEST) {
        for (const c of route.candidates) if (!c.evalRef) add("no_eval", c.model);
      }
    }
    for (const c of stepDown) if (!c.evalRef) add("step_down_no_eval", c.model);
  }
  return issues;
}
