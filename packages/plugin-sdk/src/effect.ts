// SPDX-License-Identifier: MIT

// An effect capability is one kind of external effect a plugin performs (a send, a
// publish, a CRM write). The host's Dispatcher is the only caller of execute and
// reconcile, and only for an approved, claimed ledger Action.

/**
 * How an uncertain outcome is resolved:
 * - provider_idempotent: the provider accepts our idempotency key, so a resend with the
 *   same key and byte-identical payload cannot create a second effect inside its window.
 * - queryable: the provider can be asked, by correlation key, whether the effect happened.
 * - blind: neither; an uncertain outcome is held for a person. MCP effects are always blind.
 */
export type DedupeClass = "provider_idempotent" | "queryable" | "blind";

export type ExecuteContext = {
  /** The workspace the Action belongs to; the host fetches that workspace's credential. */
  workspaceId: string;
  /** Stable for the Action's whole life, including resends. */
  idempotencyKey: string;
  /** The credential the Action sends through, such as one person's mailbox; null for none. */
  credentialId?: string | null;
};

/** One follow-up after the main effect. "uncertain": its connection dropped, so it may have posted. */
export type FollowUpResult = { status: "posted" | "failed" | "uncertain"; url?: string; detail?: string };

export type ExecuteResult =
  | { kind: "sent"; providerRef?: string; correlationKey?: string; url?: string; followUps?: FollowUpResult[] }
  /**
   * The provider definitively did not perform the effect. permanent: it never will for
   * this target (a hard bounce). retryable: the same request may succeed later.
   */
  | {
      kind: "refused";
      permanent: boolean;
      retryable: boolean;
      detail?: string;
      /** The provider refused this credential, so a person must reconnect it. */
      credentialRejected?: boolean;
      /** The provider said the sender is over its sending limit, or that the mail looks like abuse. */
      providerLimit?: ProviderLimit;
      /** The account's plan does not allow this; the plan it needs, such as "Pro". */
      plan?: string;
    };

export type ProviderLimit = "sending_limit" | "abuse";

/**
 * What reconcile found. `refused` is final: the provider answered that it never will, such as access
 * removed, so the ledger Blocks the Action instead of trying it again (ADR 0025 rule 005).
 */
export type ReconcileResult = { kind: "sent"; providerRef?: string; url?: string } | { kind: "not_sent" } | { kind: "unknown" } | { kind: "refused"; detail: string };

/** A worker is held for the whole call, so even a slow provider gets a fixed ceiling. */
export const MAX_EFFECT_TIMEOUT_MS = 5 * 60_000;

type Execute = (spec: unknown, ctx: ExecuteContext) => Promise<ExecuteResult>;

export type EffectCapability = (
  | { dedupe: "provider_idempotent"; keyWindowMs: number; execute: Execute }
  | {
      dedupe: "queryable";
      execute: Execute;
      /** `spec` is the canonical spec the Action was approved with, so reconcile knows what to look for. */
      reconcile: (correlationKey: string, ctx: ExecuteContext, spec?: unknown) => Promise<ReconcileResult>;
    }
  | { dedupe: "blind"; execute: Execute }
) & {
  /** The effect reaches a Person (an email, a call), so its Action is a Touch and must say whom. */
  reachesPerson: boolean;
  /** How long one call may take, up to MAX_EFFECT_TIMEOUT_MS. The host's default otherwise. */
  timeoutMs?: number;
};
