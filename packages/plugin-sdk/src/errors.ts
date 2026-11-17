// SPDX-License-Identifier: MIT

// How a plugin says why a query, a poll or a webhook normalize failed. Throw a PluginError; the
// host reads its fields, never its message, which is for logs only. An effect's outcome is an
// ExecuteResult instead, so the ledger can tell a refusal from an unknown outcome.
import { z } from "zod";

export const PLUGIN_REASONS = [
  "invalid_params",
  "not_connected",
  "credential_rejected",
  "rate_limited",
  "not_found",
  "plan_required",
  "provider_error",
  "failed",
] as const;
export type PluginReason = (typeof PLUGIN_REASONS)[number];

export type PluginErrorFields = {
  /** The provider's HTTP status, when there was one. */
  status?: number;
  /** How long to wait before asking again, when the provider said. */
  waitMs?: number;
  /** For plan_required: the plan the account needs. */
  plan?: string;
  /** A finer reason the query's catalogue entry lists, such as "no_access" for docs.page_text. */
  code?: string;
};

export class PluginError extends Error {
  readonly reason: PluginReason;
  readonly status?: number;
  readonly waitMs?: number;
  readonly plan?: string;
  readonly code?: string;
  constructor(reason: PluginReason, message: string, fields: PluginErrorFields = {}) {
    super(message);
    this.reason = reason;
    Object.assign(this, fields);
  }
}

/** The error data a plugin error crosses the wire with. */
export const errorData = (e: PluginError): PluginErrorFields & { reason: PluginReason } => ({
  reason: e.reason,
  ...(e.status !== undefined && { status: e.status }),
  ...(e.waitMs !== undefined && { waitMs: e.waitMs }),
  ...(e.plan !== undefined && { plan: e.plan }),
  ...(e.code !== undefined && { code: e.code }),
});

/**
 * Error data as a host reads it: unknown keys dropped, a reason this SDK does not know read as
 * "failed" with the wait kept, and a field of the wrong type dropped, so a newer plugin's error
 * never fails the host's parse.
 */
export function readErrorData(data: unknown): PluginErrorFields & { reason: PluginReason } {
  const d = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const field = <T>(s: z.ZodType<T>, v: unknown): T | undefined => (s.safeParse(v).success ? (v as T) : undefined);
  const reason = field(z.enum(PLUGIN_REASONS), d.reason) ?? "failed";
  const status = field(z.number().int().min(100).max(599), d.status);
  const waitMs = field(z.number().int().nonnegative(), d.waitMs);
  const plan = field(z.string().min(1).max(40), d.plan);
  const code = field(z.string().regex(/^[a-z_]{1,40}$/), d.code);
  return { reason, ...(status !== undefined && { status }), ...(waitMs !== undefined && { waitMs }), ...(plan !== undefined && { plan }), ...(code !== undefined && { code }) };
}
