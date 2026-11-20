// SPDX-License-Identifier: AGPL-3.0-only
// The identity module's only public entry point: sign-in, sessions, and who may do what in
// which Workspace.
import { authConfigFromEnv, createAuth, type Auth, type AuthConfig } from "./adapters/auth";
import { isDevOrTest } from "./adapters/mail";
import * as repo from "./adapters/repo";
import { pickAdmission } from "./application/admission";
import { listMembers, type OnDelete, type OnMemberChange } from "./application/members";
import type { Admission } from "./domain/admission";
import { can } from "./domain/roles";
import { memberRoutes } from "./members-routes";
import { identityRoutes } from "./routes";
import { serverRoutes } from "./server-routes";

export { authConfigFromEnv, type Auth, type AuthConfig } from "./adapters/auth";
export { checkSmtp, isDevOrTest, logMailer, smtpMailer, type Mail, type Mailer, type SmtpCheck } from "./adapters/mail";
export { pickAdmission, selfHostAdmission } from "./application/admission";
export { approverFromMember, approverMayApprove, mayGrantRules, workspaceLive } from "./application/approver-check";
export type { Admission, AdmitInput, AdmitResult, FirstRun, ServerStatus, SignupPolicy } from "./domain/admission";
export { can, ROLES, type Permission, type Role } from "./domain/roles";
export { readSession, refuseExternalTokens, requireMember, requirePermission, requireStepUp, steppedUp, type Member, type StepUpWindow, type MemberEnv } from "./middleware";
export { adminSteppedUp, requireServerAdmin, type ServerAdminEnv } from "./server-routes";

/** Who to tell about the Workspace's settings: its Owners and Admins. */
export const adminEmails = async (workspaceId: string): Promise<string[]> =>
  (await listMembers(workspaceId)).filter((m) => can(m.role, "workspace.settings")).map((m) => m.email);

/** The Workspace's name for a notice, or null when it has none or the lookup fails. */
export async function workspaceName(workspaceId: string): Promise<string | null> {
  try {
    return await repo.inWorkspace(workspaceId, repo.workspaceName);
  } catch (error) {
    // Once the purge starts, the notice must stop too.
    if (error instanceof repo.WorkspacePurging) throw error;
    return null;
  }
}

/**
 * Names the Workspace in a notice, so an Admin of several Workspaces can tell which one it is about.
 * Without a name the notice goes out as it is: a missing name never stops a notice.
 */
export const named =
  (name: string | null) =>
  (m: { subject: string; text: string }): { subject: string; text: string } =>
    name ? { subject: `${name}: ${m.subject}`, text: `Workspace: ${name}\n\n${m.text}` } : m;

/** One member's address, or undefined when they have left. */
export const memberEmail = async (workspaceId: string, userId: string): Promise<string | undefined> =>
  (await listMembers(workspaceId)).find((m) => m.userId === userId)?.email;

/** Each member's name, or their address when the name is empty. People who left are absent. */
export const memberNames = async (workspaceId: string): Promise<Map<string, string>> =>
  new Map((await listMembers(workspaceId)).map((m) => [m.userId, m.name || m.email]));

/** One member's role and address, or undefined when they have left. */
export const memberOf = async (workspaceId: string, userId: string) => {
  const m = (await listMembers(workspaceId)).find((x) => x.userId === userId);
  return m && { role: m.role, email: m.email };
};

/**
 * Builds auth from `config` (default: the environment) the first time a route needs it.
 * `admission` defaults to the self-host rules, and throws in cloud, which must supply its own.
 * `onDelete` runs in the transaction that deletes a Workspace; `onMemberChange` after a role change
 * or removal commits.
 */
export function createIdentity(
  config: () => AuthConfig = () => authConfigFromEnv(),
  admission: () => Admission = () => pickAdmission("self_host", undefined, isDevOrTest(process.env)),
  onDelete?: OnDelete,
  onMemberChange?: OnMemberChange,
) {
  let cfg: AuthConfig | undefined;
  let auth: Auth | undefined;
  const getConfig = () => (cfg ??= config());
  const get = () => (auth ??= createAuth(getConfig(), admission));
  const routes = identityRoutes(get, () => getConfig().baseURL, admission);
  routes.route("/", memberRoutes(get, () => ({ mailer: getConfig().mailer, baseURL: getConfig().baseURL }), onDelete, onMemberChange));
  routes.route("/", serverRoutes(get, () => getConfig().mailer, admission));
  return { routes, auth: get, config: getConfig, admission };
}
