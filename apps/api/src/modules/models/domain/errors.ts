// SPDX-License-Identifier: AGPL-3.0-only
// Pure: why a call did not run, and how a dispatched one failed.

export type Refusal =
  | "no_route"
  | "no_connection"
  | "no_shared_sign_in"
  | "credential_unavailable"
  | "effect_tool_on_untrusted"
  | "stale_claim"
  | "run_cap"
  | "budget_stop"
  | "safety_daily_cap"
  | "unpriced"
  | "duplicate"
  /** Whoever runs this Direx holds the Workspace, its Organization or the deployment. */
  | "operator_hold";

export type ErrorFamily = "configuration" | "transient_upstream" | "provider_quota" | "model_refusal" | "no_receipt";
