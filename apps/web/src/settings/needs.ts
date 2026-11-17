// SPDX-License-Identifier: AGPL-3.0-only
// What on Settings needs a person now. Kept apart from the Overview so the Settings nav can mark it without loading the page.
import { useQuery } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { dayWords } from "../campaigns/actions";
import { credentialsQuery, mailboxChecksQuery, existingMailboxProvidersQuery, split, type Credential, type MailboxCheck } from "../credentials/actions";
import { accountsQuery, type Account } from "../social/actions";
import { dollars, modelsQuery } from "../models/actions";
import { rulesQuery, type Rule } from "../standing-rules/actions";

type S = components["schemas"];
type To = "/w/$workspaceId/settings/credentials" | "/w/$workspaceId/settings/social" | "/w/$workspaceId/settings/models" | "/w/$workspaceId/settings/rules";
export type Need = { key: string; what: string; why: string; to: To; act: string };

/** Everything on Settings that needs a person now: email accounts, then social accounts, rules and the budget. */
export function needs(p: { mailboxes: Credential[]; checks: MailboxCheck[]; accounts: Account[]; usage?: { settledMicros: string; budgetMicros: string } | undefined; rules: Rule[] }): Need[] {
  const out: Need[] = [];
  for (const m of p.mailboxes)
    if (m.status !== "active") out.push({ key: m.id, what: `${m.name} stopped sending.`, why: "Direx can't sign in to it any more. Approved emails from it wait until you reconnect.", to: "/w/$workspaceId/settings/credentials", act: "Reconnect" });
    else if (p.checks.find((c) => c.credentialId === m.id)?.state !== "passed")
      out.push({ key: m.id, what: `${m.name} hasn't passed its unsubscribe check.`, why: "No cold email goes from it until it does.", to: "/w/$workspaceId/settings/credentials", act: "Check it" });
  for (const a of p.accounts)
    if (a.status !== "active") out.push({ key: a.id, what: `${a.network} account ${a.name} needs reconnecting.`, why: "Posts to it wait until you reconnect.", to: "/w/$workspaceId/settings/social", act: "Reconnect" });
    else if (a.warning)
      out.push({ key: a.id, what: `${a.network} account ${a.name} must be reconnected by ${dayWords(a.warning.endsAt.slice(0, 10))}.`, why: `${a.network} asks for a fresh sign-in from time to time.`, to: "/w/$workspaceId/settings/social", act: "Reconnect" });
  for (const r of p.rules)
    if (r.status === "suspended") out.push({ key: r.id, what: "An auto-approve rule stopped and needs review.", why: r.suspendedReason ?? "Something it relies on changed.", to: "/w/$workspaceId/settings/rules", act: "Review" });
  if (p.usage && Number(p.usage.settledMicros) >= 0.8 * Number(p.usage.budgetMicros))
    out.push({ key: "budget", what: `AI cost is at ${dollars(p.usage.settledMicros)} of the ${dollars(p.usage.budgetMicros)} budget.`, why: "At the budget, Direx stops drafting until next month.", to: "/w/$workspaceId/settings/models", act: "See AI cost" });
  return out;
}

/** What needs someone across Settings, from the same queries each Settings screen reads. */
export function useNeeds(workspace: S["MyWorkspace"], me: string) {
  const id = workspace.id;
  const manage = workspace.role === "owner" || workspace.role === "admin";
  const credentials = useQuery(credentialsQuery(id)).data;
  const providers = useQuery(existingMailboxProvidersQuery(id)).data;
  const checks = useQuery(mailboxChecksQuery(id)).data ?? [];
  const accounts = useQuery(accountsQuery(id)).data;
  const usage = useQuery(modelsQuery(id, manage)).data?.usage;
  const rules = useQuery(rulesQuery(id)).data;
  const mailboxes = credentials && providers ? split(credentials, me, [], [], providers.map((x) => x.connection)).mailboxes : undefined;
  return { mailboxes, accounts, usage, rules, list: needs({ mailboxes: mailboxes ?? [], checks, accounts: accounts ?? [], usage, rules: rules ?? [] }) };
}
