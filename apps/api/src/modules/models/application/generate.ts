// SPDX-License-Identifier: AGPL-3.0-only
// One model call: trust, route, tools, reserve, dispatch, settle. Two short transactions,
// and no lock is held over the network. Refusals are values and leave a row.
import { createHash } from "node:crypto";
import { z, type ZodType } from "zod";
import { utcMonth, withBudget, type BudgetScope } from "../../ledger/index";
import type { Keys } from "../adapters/keys";
import * as repo from "../adapters/repo";
import { SIGNED_OUT_REASON } from "../adapters/runtime/envelope";
import { ADAPTERS } from "../adapters/runtime/registry";
import type { Dispatch, DispatchUsage, ToolCall, ToolDef } from "../adapters/sdk";
import { budgetDecision, DEFAULT_BUDGET_MICROS, safetyAllowed, thresholdsCrossed, withinRunCap, type Deployment } from "../domain/budget";
import { actualMicros, worstCaseMicros } from "../domain/cost";
import type { ErrorFamily, Refusal } from "../domain/errors";
import { RATE_CARDS } from "../domain/rates/cards";
import { isCliProvider, SAFETY_PURPOSES, type Candidate, type Provider, type Route } from "../domain/routes-check";
import { callTrust, kindTrust, toolsFor, type Trust } from "../domain/trust";

/** How long one call may run before it counts as having no receipt. */
const CALL_TIMEOUT_MS = 10 * 60_000;
const MICROS_PER_USD = 1_000_000;
const DAY_MS = 86_400_000;
const DEFAULT_CLI_OUTPUT_TOKENS = 4096;
/** A hold with no outcome after this long belongs to a worker that died. */
const ABANDONED_AFTER_MS = 60 * 60_000;

export type ContextPart = { role: "system" | "user"; kind: string; text: string; ref?: { kind: string; id: string } };

export type RunContext = { id: string; claimToken: string; costCapMicros: bigint; attempt: number };

export type ModelRequest<T = unknown> = {
  workspaceId: string;
  purpose: string;
  idempotencyKey: string;
  parts: ContextPart[];
  tools?: ToolDef[];
  output?: ZodType<T>;
  run?: RunContext;
  actorUserId?: string;
  /** The agent asking, whose own choice of AI wins over the Workspace's. */
  agent?: string;
  abortSignal?: AbortSignal;
};

export type ModelResult<T = unknown> =
  | { ok: true; callId: string; trust: Trust; output: T | string; toolCalls: ToolCall[]; routeHash: string }
  | { ok: false; callId: string | null; refusal: Refusal }
  | { ok: false; callId: string; errorFamily: ErrorFamily; retryNotBefore?: Date; reason?: string };

/** Strict, so a caller that dodges the types cannot pass a model, a credential or a trust level. */
const requestSchema = z.strictObject({
  workspaceId: z.uuid(),
  purpose: z.string().min(1),
  idempotencyKey: z.string().min(1),
  parts: z.array(z.strictObject({
    role: z.enum(["system", "user"]),
    kind: z.string().min(1),
    text: z.string(),
    ref: z.strictObject({ kind: z.string(), id: z.string() }).optional(),
  })).min(1),
  tools: z.array(z.strictObject({ name: z.string(), description: z.string(), class: z.enum(["read", "effect"]), inputSchema: z.custom<ZodType>() })).optional(),
  output: z.custom<ZodType>().optional(),
  run: z.strictObject({ id: z.uuid(), claimToken: z.string(), costCapMicros: z.bigint(), attempt: z.number().int().min(0) }).optional(),
  actorUserId: z.uuid().optional(),
  agent: z.string().min(1).optional(),
  abortSignal: z.custom<AbortSignal>().optional(),
});

/** Cloud: whether this model is in the agent's routes with a passing eval for its current definition. */
export type OverrideAllowed = (agent: string, provider: string, model: string) => boolean;

/** Passed in by the composition root, so this module never imports the one that owns runs. */
export type RunGate = (workspaceId: string, runId: string, claimToken: string) => Promise<{ live: boolean; tainted: boolean }>;

export type GenerateDeps = {
  deployment: Deployment;
  routes: Readonly<Record<string, Route>>;
  keys: Keys;
  dispatch: Dispatch;
  runGate: RunGate;
  notifyAdmins: (workspaceId: string, incident: { month: string; threshold: number }) => Promise<void>;
  /** Arranges for settleAbandoned to run at `at`, committed with the hold. */
  watchHold: (tx: BudgetScope["tx"], workspaceId: string, callId: string, at: Date) => Promise<void>;
  now: () => Date;
  baseURLs?: Partial<Record<Provider, string>>;
  /** Cloud: whether an agent's chosen model still has a passing eval for its current definition. */
  overrideAllowed?: OverrideAllowed;
  /** Cloud: an agent's choice just stopped passing, so its runs use the default model. */
  notifyPaused?: (workspaceId: string, paused: { agent: string; model: string }) => Promise<void>;
};

export const routeHash = (purpose: string, c: Candidate): string =>
  createHash("sha256").update(JSON.stringify({ purpose, provider: c.provider, model: c.model, maxOutputTokens: c.maxOutputTokens })).digest("hex");

/** The candidate for this attempt: a retry moves to the next one with a key. */
function pick(candidates: readonly Candidate[], available: Set<Provider>, attempt: number): Candidate | undefined {
  const usable = candidates.filter((c) => available.has(c.provider));
  return usable[Math.min(attempt, usable.length - 1)];
}

/**
 * The AI a person picked, in the shape of a route candidate. It replaces the route, so nothing falls back.
 * Picked without a model, the purpose's own candidate on that AI runs, model and eval included, so a
 * purpose that passed on one model isn't moved to the AI's first.
 */
function chosenCandidate(adapter: string, model: string | null | undefined, route: Route | undefined): Candidate | null {
  const known = ADAPTERS.find((a) => a.id === adapter);
  if (!known) return null;
  const routed = route?.candidates.find((c) => c.provider === adapter && (model ? c.model === model : true));
  if (routed) return routed;
  return { provider: known.id, model: model ?? known.models[0]!, maxOutputTokens: route?.candidates[0]?.maxOutputTokens ?? DEFAULT_CLI_OUTPUT_TOKENS, price: null, evalRef: null };
}

const reservationFor = (bytes: number, c: Candidate) => (c.price ? worstCaseMicros(bytes, c.maxOutputTokens, c.price) : 0n);

function provenance(model: string): string | undefined {
  const card = (RATE_CARDS as Record<string, { source: string; readOn: string }>)[model];
  return card && `${card.source}@${card.readOn}`;
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

function inputBytes(parts: readonly ContextPart[], tools: readonly ToolDef[]): number {
  const schemas = tools.map((t) => ({ name: t.name, description: t.description, schema: z.toJSONSchema(t.inputSchema) }));
  return parts.reduce((n, p) => n + utf8Length(p.text), 0) + utf8Length(JSON.stringify(schemas));
}

export function createGenerate(d: GenerateDeps) {
  async function settings(tx: BudgetScope["tx"]) {
    return (await repo.latestSettings(tx)) ?? { monthlyBudgetMicros: DEFAULT_BUDGET_MICROS[d.deployment], allowUnpriced: false };
  }

  /** Records the outcome and spend, opens any incident this crossed, and tells Admins after commit. */
  async function settle(a: {
    workspaceId: string;
    callId: string;
    reservationId: string;
    heldAt: Date;
    /** Null releases the hold: the provider said no and charged nothing. */
    micros: bigint | null;
    patch: repo.CallPatch;
    /** The sweep must not overwrite an outcome its worker recorded a moment earlier. */
    onlyIfOpen?: boolean;
  }) {
    const at = d.now();
    const month = utcMonth(a.heldAt).key;
    const opened = await withBudget(a.workspaceId, async (b) => {
      if (a.onlyIfOpen && !(await repo.dispatchedCall(b.tx, a.callId))) return [];
      const before = await b.settled("model", a.heldAt);
      if (a.micros === null) await b.release(a.reservationId, at);
      else await b.settle(a.reservationId, a.micros, at);
      await repo.patchCall(b.tx, a.callId, { ...a.patch, settledAt: at });
      const after = await b.settled("model", a.heldAt);
      const { monthlyBudgetMicros } = await settings(b.tx);
      const fresh: number[] = [];
      for (const t of thresholdsCrossed(before, after, monthlyBudgetMicros)) {
        if (await repo.openIncident(b.tx, a.workspaceId, month, t, at)) fresh.push(t);
      }
      return fresh;
    });
    // The spend is recorded; a mail server being down must not lose the caller's result.
    for (const threshold of opened) {
      await d.notifyAdmins(a.workspaceId, { month, threshold }).catch((e) => console.error("models: budget notice failed:", e));
    }
  }

  const tokenColumns = (u: DispatchUsage) => ({
    inputTokens: u.tokensUnknown ? null : u.noCacheTokens + u.cacheReadTokens + u.cacheWriteTokens,
    cacheReadTokens: u.tokensUnknown ? null : u.cacheReadTokens,
    cacheWriteTokens: u.tokensUnknown ? null : u.cacheWriteTokens,
    outputTokens: u.tokensUnknown ? null : u.outputTokens,
    reasoningTokens: u.tokensUnknown ? null : u.reasoningTokens,
  });

  /**
   * Cloud: the agent's own choice, used only while a passing eval covers it and it is in this route.
   * Otherwise the default route runs, the choice is marked paused, and Admins hear once.
   */
  async function cloudChoice(ws: string, agent: string, configured: Route | undefined): Promise<Route | undefined> {
    const own = await repo.ownChoice(ws, agent);
    if (!own) return undefined;
    const candidate = own.model ? configured?.candidates.find((c) => c.provider === own.adapter && c.model === own.model) : undefined;
    if (candidate && d.overrideAllowed?.(agent, own.adapter, candidate.model)) {
      if (own.pausedAt) await repo.resumeChoice(ws, agent);
      return { candidates: [candidate] };
    }
    if (await repo.pauseChoice(ws, agent, d.now())) {
      await d.notifyPaused?.(ws, { agent, model: own.model ?? own.adapter }).catch((e) => console.error("models: paused choice notice failed:", e));
    }
    return undefined;
  }

  /** `only` keeps a call to one provider, for testing a connection. Callers of `generate` cannot set it. */
  /** Where a call would go: the route its purpose and any pick give, and its first candidate with a key. Writes nothing. */
  async function routeFor(ws: string, purpose: string, agent: string | undefined, actorUserId: string | undefined, attempt: number, only?: Provider) {
    const configured = d.routes[purpose];
    // Safety purposes keep their pinned route, whatever anyone picked.
    const picks = !only && !SAFETY_PURPOSES.has(purpose);
    const choice = d.deployment === "self_host" && picks ? await repo.adapterChoice(ws, agent) : null;
    const chosen = choice ? chosenCandidate(choice.adapter, choice.model, configured) : only && isCliProvider(only) ? chosenCandidate(only, null, configured) : null;
    const cloudPick = d.deployment === "cloud" && picks && agent ? await cloudChoice(ws, agent, configured) : undefined;
    const route: Route | undefined = chosen ? { candidates: [chosen] } : (cloudPick ?? configured);
    let available = await d.keys.available(ws, actorUserId);
    if (only) available = new Set([...available].filter((p) => p === only));
    return { chosen, route, available, first: route && pick(route.candidates, available, attempt) };
  }

  async function run<T>(raw: ModelRequest<T>, only?: Provider): Promise<ModelResult<T>> {
    const req = requestSchema.parse(raw) as ModelRequest<T>;
    const { workspaceId: ws, purpose, idempotencyKey } = req;
    const heldAt = d.now();
    const gate = req.run ? await d.runGate(ws, req.run.id, req.run.claimToken) : { live: true, tainted: false };
    const trust = callTrust(req.parts.map((p) => p.kind), gate.tainted);
    const tools = toolsFor(trust, req.tools ?? []);

    const attempt = req.run?.attempt ?? 0;
    const { chosen, route, available, first } = await routeFor(ws, purpose, req.agent, req.actorUserId, attempt, only);

    const system = req.parts.filter((p) => p.role === "system").map((p) => p.text).join("\n\n") || undefined;
    const messages = req.parts.filter((p) => p.role === "user").map((p) => ({ role: "user" as const, content: p.text }));
    const bytes = inputBytes(req.parts, req.tools ?? []);

    const common = {
      workspaceId: ws,
      idempotencyKey,
      actorUserId: req.actorUserId,
      runId: req.run?.id,
      purpose,
      trust,
      attempt,
      untrustedSources: req.parts.filter((p) => kindTrust(p.kind) === "untrusted").map((p) => p.ref ?? { kind: p.kind, id: null }),
      createdAt: heldAt,
    };

    const decided = await withBudget(ws, async (b) => {
      const refuse = async (refusal: Refusal) => {
        const callId = await repo.writeCall(b.tx, { ...common, status: "refused", refusal, toolsOffered: [] });
        return { refusal, callId } as const;
      };
      const duplicate = await repo.liveCallId(b.tx, idempotencyKey);
      if (duplicate) return { refusal: "duplicate", callId: duplicate } as const;
      if (!gate.live) return refuse("stale_claim");
      if (tools === "effect_tool_on_untrusted") return refuse("effect_tool_on_untrusted");
      if (!route) return refuse("no_route");
      if (!first) return refuse(chosen && !req.actorUserId ? "no_shared_sign_in" : "no_connection");

      const s = await settings(b.tx);
      let candidate = first;
      if (!candidate.price && !isCliProvider(candidate.provider) && !(d.deployment === "self_host" && s.allowUnpriced)) return refuse("unpriced");

      if (SAFETY_PURPOSES.has(purpose)) {
        const day = new Date(Date.UTC(heldAt.getUTCFullYear(), heldAt.getUTCMonth(), heldAt.getUTCDate()));
        const today = await repo.purposeCallsBetween(b.tx, [...SAFETY_PURPOSES], day, new Date(day.getTime() + DAY_MS));
        if (!safetyAllowed(today)) return refuse("safety_daily_cap");
      } else if (!isCliProvider(candidate.provider)) {
        const lower = route.stepDown && pick(route.stepDown, available, 0);
        const decision = budgetDecision({
          deployment: d.deployment,
          spentMicros: await b.spent("model", heldAt),
          budgetMicros: s.monthlyBudgetMicros,
          reservationMicros: reservationFor(bytes, candidate),
          stepDownMicros: lower ? reservationFor(bytes, lower) : null,
        });
        if (decision === "budget_stop") return refuse("budget_stop");
        if (decision === "step_down") candidate = lower!;
      }

      const reservedMicros = reservationFor(bytes, candidate);
      if (req.run) {
        const spentOnRunMicros = await repo.spentOnRun(b.tx, req.run.id);
        if (!withinRunCap({ capMicros: req.run.costCapMicros, spentOnRunMicros, reservationMicros: reservedMicros })) return refuse("run_cap");
      }

      // Unpriced calls hold nothing, but the hold still carries any cost the provider reports.
      const reservationId = await b.hold("model", reservedMicros, heldAt);
      const hash = routeHash(purpose, candidate);
      const callId = await repo.writeCall(b.tx, {
        ...common,
        status: "dispatched",
        routeHash: hash,
        provider: candidate.provider,
        requestedModel: candidate.model,
        credentialKind: d.keys.kindOf(candidate.provider),
        toolsOffered: (tools as readonly ToolDef[]).map((t) => t.name),
        reservationId,
      });
      await d.watchHold(b.tx, ws, callId, new Date(d.now().getTime() + ABANDONED_AFTER_MS));
      return { callId, reservationId, reservedMicros, candidate, hash } as const;
    });

    if ("refusal" in decided) return { ok: false, callId: decided.callId, refusal: decided.refusal as Refusal };
    const { callId, reservationId, reservedMicros, candidate, hash } = decided;

    const signal = AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), ...(req.abortSignal ? [req.abortSignal] : [])]);
    const result = await d.keys.withKey(ws, candidate.provider, (apiKey, replaceKey) =>
      d.dispatch({
        provider: candidate.provider,
        model: candidate.model,
        apiKey,
        baseURL: d.baseURLs?.[candidate.provider],
        system,
        messages,
        tools: tools as readonly ToolDef[],
        output: req.output,
        maxOutputTokens: candidate.maxOutputTokens,
        abortSignal: signal,
        replaceKey,
      }),
      req.actorUserId,
    );
    const subscription = isCliProvider(candidate.provider);
    if (subscription && result) {
      const signedOut = !result.ok && "reason" in result && result.reason === SIGNED_OUT_REASON;
      if (result.ok || signedOut) await d.keys.signInOutcome?.(ws, candidate.provider, req.actorUserId, result.ok);
    }

    const base = { workspaceId: ws, callId, reservationId, heldAt };

    if (result === null) {
      await settle({ ...base, micros: null, patch: { status: "refused", refusal: "credential_unavailable" } });
      return { ok: false, callId, refusal: "credential_unavailable" };
    }

    if (result.ok) {
      const reported = result.reportedCostUsd;
      const micros = subscription
        ? 0n
        : reported !== undefined ? BigInt(Math.ceil(reported * MICROS_PER_USD)) : candidate.price ? actualMicros(result.usage, candidate.price) : 0n;
      await settle({
        ...base,
        micros,
        patch: {
          status: "completed",
          errorFamily: null,
          resolvedModel: result.resolvedModel,
          providerRequestId: result.providerRequestId,
          ...tokenColumns(result.usage),
          costMicros: micros,
          costStatus: subscription ? "subscription" : reported !== undefined ? "reported" : candidate.price ? "estimated" : "unpriced",
          pricingProvenance: reported !== undefined ? "provider" : provenance(candidate.model),
          overReserved: Boolean(candidate.price) && micros > reservedMicros,
        },
      });
      return { ok: true, callId, trust, output: (req.output ? result.output : result.text) as T | string, toolCalls: result.toolCalls, routeHash: hash };
    }

    if ("usage" in result) {
      // Charged for output that was refused or failed its schema.
      const micros = result.usage && candidate.price ? actualMicros(result.usage, candidate.price) : reservedMicros;
      await settle({
        ...base,
        micros,
        patch: {
          status: "failed",
          errorFamily: result.family,
          ...(result.usage ? tokenColumns(result.usage) : {}),
          costMicros: micros,
          costStatus: subscription ? "subscription" : result.usage ? "estimated" : "unknown",
          pricingProvenance: provenance(candidate.model),
        },
      });
      return { ok: false, callId, errorFamily: result.family, ...(result.reason && { reason: result.reason }) };
    }

    if (result.definite) {
      await settle({ ...base, micros: null, patch: { status: "failed", errorFamily: result.family, costMicros: 0n, costStatus: "reported" } });
      return { ok: false, callId, errorFamily: result.family, retryNotBefore: result.retryNotBefore, reason: result.reason };
    }

    // No receipt: the provider may have billed, so charge the full hold.
    await settle({ ...base, micros: reservedMicros, patch: { status: "failed", errorFamily: "no_receipt", costMicros: reservedMicros, costStatus: "unknown" } });
    return { ok: false, callId, errorFamily: "no_receipt" };
  }

  return {
    generate: <T>(req: ModelRequest<T>) => run(req),
    availableProviders: (workspaceId: string) => d.keys.available(workspaceId),
    /** Whether this agent's calls for this purpose would go to a subscription (Claude Code, Codex), which costs no money per call. */
    async runsOnSubscription(workspaceId: string, a: { agent: string; purpose: string; actorUserId?: string }): Promise<boolean> {
      const { first } = await routeFor(workspaceId, a.purpose, a.agent, a.actorUserId, 0);
      return !!first && isCliProvider(first.provider);
    },
    /** Charges the full hold of a call whose worker never came back. A later receipt corrects it. */
    async settleAbandoned(workspaceId: string, callId: string) {
      const call = await repo.openCall(workspaceId, callId);
      if (!call?.reservationId) return;
      await settle({
        workspaceId,
        callId,
        reservationId: call.reservationId,
        heldAt: call.createdAt,
        micros: call.reservedMicros,
        onlyIfOpen: true,
        patch: { status: "failed", errorFamily: "no_receipt", costMicros: call.reservedMicros, costStatus: "unknown" },
      });
    },
    testConnection: (workspaceId: string, provider: Provider, actorUserId: string, text = "Reply with OK.") =>
      run(
        {
          workspaceId,
          purpose: "connection_test",
          idempotencyKey: `connection_test:${crypto.randomUUID()}`,
          actorUserId,
          parts: [{ role: "user", kind: "definition", text }],
        },
        provider,
      ),
  };
}

export type Models = ReturnType<typeof createGenerate>;
