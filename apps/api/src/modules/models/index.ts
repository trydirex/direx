// SPDX-License-Identifier: AGPL-3.0-only
// The only code that talks to a model, and this module's only entry point. A caller names a
// purpose and hands typed context; it never picks a model or holds a key.
import type { PgBoss } from "pg-boss";
import type { Vault } from "../credentials/index";
import { named, workspaceName, type Mailer } from "../identity/index";
import { createKeys, type Keys } from "./adapters/keys";
import { sendHoldWatch, workHoldWatch } from "./adapters/queue";
import { withCliAdapters } from "./adapters/runtime/registry";
import { sdkDispatch, type Dispatch } from "./adapters/sdk";
import { createGenerate, type GenerateDeps, type Models, type RunGate } from "./application/generate";
import type { OverrideAllowed } from "./application/sign-ins";
import type { Deployment } from "./domain/budget";
import { checkRoutes, isPinned, type Route } from "./domain/routes-check";
import { CHECK_CANDIDATES, CLAIM_CHECK_MODEL, routesFor } from "./purposes";

export type { ContextPart, ModelRequest, ModelResult, Models, RunContext, RunGate } from "./application/generate";
export type { ToolCall, ToolDef } from "./adapters/sdk";
export type { Deployment } from "./domain/budget";
export type { Route } from "./domain/routes-check";
export type { ErrorFamily, Refusal } from "./domain/errors";
export { workHoldWatch, routesFor, isPinned, CHECK_CANDIDATES, CLAIM_CHECK_MODEL };
export { ranOnSubscription, runCost } from "./adapters/repo";
export { runSandboxed, sandboxStatus, spawnSandboxed, type SandboxedProcess, type SandboxResult, type SandboxRun, type SandboxSpawn } from "./adapters/runtime/sandbox";
export { modelRoutes, type ModelRouteDeps } from "./routes";
export { modelSignInKind, signInNeeds, type Evaluated, type OverrideAllowed } from "./application/sign-ins";

export function createModels(a: {
  deployment: Deployment;
  routes?: GenerateDeps["routes"];
  vault?: () => Vault;
  keys?: Keys;
  runGate?: RunGate;
  notifyAdmins?: GenerateDeps["notifyAdmins"];
  watchHold?: GenerateDeps["watchHold"];
  now?: () => Date;
  dispatch?: Dispatch;
  baseURLs?: GenerateDeps["baseURLs"];
  overrideAllowed?: GenerateDeps["overrideAllowed"];
  notifyPaused?: GenerateDeps["notifyPaused"];
}) {
  return createGenerate({
    deployment: a.deployment,
    routes: a.routes ?? routesFor(a.deployment),
    keys: a.keys ?? createKeys({ deployment: a.deployment, vault: a.vault }),
    dispatch: a.dispatch ?? (a.deployment === "self_host" ? withCliAdapters(sdkDispatch) : sdkDispatch),
    // Until runs exist, nothing can claim to be one.
    runGate: a.runGate ?? (async () => ({ live: false, tainted: true })),
    notifyAdmins: a.notifyAdmins ?? (async () => {}),
    watchHold: a.watchHold ?? (async () => {}),
    now: a.now ?? (() => new Date()),
    baseURLs: a.baseURLs,
    overrideAllowed: a.overrideAllowed,
    notifyPaused: a.notifyPaused,
  });
}

export function deploymentFromEnv(env: Record<string, string | undefined> = process.env): Deployment {
  const value = env.DIREX_DEPLOYMENT ?? "self_host";
  if (value === "cloud" || value === "self_host") return value;
  throw new Error(`DIREX_DEPLOYMENT must be cloud or self_host, not ${value}`);
}

/** Refuses to boot on route config the deployment forbids, naming each purpose and reason. */
export function assertRoutes(deployment: Deployment, routes: Readonly<Record<string, Route>>): void {
  const issues = checkRoutes(deployment, routes);
  if (issues.length === 0) return;
  throw new Error(`models: bad route config: ${issues.map((i) => `${i.purpose}: ${i.reason}${i.model ? ` (${i.model})` : ""}`).join("; ")}`);
}

/** The two notices to a Workspace's Owners and Admins, each naming the Workspace. */
export function adminNotices(a: { mailer: Mailer; adminEmails: (workspaceId: string) => Promise<string[]> }): Required<Pick<GenerateDeps, "notifyPaused" | "notifyAdmins">> {
  const tell = async (workspaceId: string, mail: { subject: string; text: string }) => {
    const sent = named(await workspaceName(workspaceId))(mail);
    for (const to of await a.adminEmails(workspaceId)) await a.mailer({ to, ...sent });
  };
  return {
    notifyPaused: (workspaceId, { agent, model }) =>
      tell(workspaceId, {
        subject: `Direx paused your choice of ${model} for ${agent}`,
        text: `Your choice of ${model} for ${agent} is paused until it passes its eval for this version. Direx is using the default model. See AI models in Workspace settings.`,
      }),
    notifyAdmins: (workspaceId, { month, threshold }) =>
      tell(workspaceId, {
        subject: `Direx model cost reached ${threshold}% of this month's budget`,
        text: `Model cost for ${month} has reached ${threshold}% of the monthly budget. See AI models in Workspace settings.`,
      }),
  };
}

/** The instance the API and the worker run with. */
export function modelsFromEnv(a: { vault: () => Vault; boss: PgBoss; mailer: Mailer; adminEmails: (workspaceId: string) => Promise<string[]>; runGate?: RunGate; signInOutcome?: Keys["signInOutcome"]; overrideAllowed?: OverrideAllowed }): Models {
  const deployment = deploymentFromEnv();
  const routes = routesFor(deployment);
  assertRoutes(deployment, routes);
  return createModels({
    deployment,
    routes,
    keys: createKeys({ deployment, vault: a.vault, signInOutcome: a.signInOutcome }),
    runGate: a.runGate,
    overrideAllowed: a.overrideAllowed,
    watchHold: (tx, workspaceId, callId, at) => sendHoldWatch(a.boss, tx, { workspaceId, callId }, at),
    ...adminNotices(a),
  });
}
