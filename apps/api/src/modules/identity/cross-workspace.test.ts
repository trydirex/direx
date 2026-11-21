// SPDX-License-Identifier: AGPL-3.0-only
// Cross-workspace access through the app as main.ts mounts it: a member of W1 gets 404 on
// every route of W2, credentials included. Routes are read from the app, so a new one without a case fails here.
import { expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { app } from "../../main";
import { TEST_SECRET, testIdentity } from "./test-auth";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
// So the connect route reaches a provider for W2's Owner; nothing calls Google.
process.env.DIREX_GOOGLE_CLIENT_ID = "google-client";
process.env.DIREX_GOOGLE_CLIENT_SECRET = "g";
process.env.DIREX_MASTER_KEY = "11".repeat(32);
// W2's Owner reaches the sign-in routes, which must never start a real CLI's login from here.
process.env.PATH = "/nonexistent";
const { call, signIn, createOrg, inviteToken } = testIdentity();

// Routes that take no Workspace. Adding one here is a decision, not a formality.
const OUTSIDE = [
  "GET /health",
  "GET /openapi.json",
  // A redirect to where this server's source is published; it reads no data at all (AGPL section 13).
  "GET /api/source",
  "GET /api/auth/*",
  "POST /api/auth/*",
  // Before sign-in: whether Google and Microsoft are set up here, two booleans and no Workspace data.
  "GET /api/sign-in-options",
  "GET /api/me",
  "GET /api/me/workspaces",
  // The caller's own deleted Workspaces where they are Owner, names and dates only, so they can reach the export (ADR 0030 rule 008).
  "GET /api/me/deleted-workspaces",
  "POST /api/orgs",
  "POST /api/invites/accept",
  "POST /api/invites/preview",
  // Holds an invite or bootstrap token in a cookie for sign-up; it reads nothing, and admission checks the token (ADR 0024).
  "POST /api/admission/token",
  // Server-wide, not Workspace data: whether the server is claimed and whether the caller may create an Organization,
  // and the bootstrap claim, which only makes the caller a Server admin (ADR 0024, rule 007).
  "GET /api/server/status",
  "POST /api/server/claim",
  "POST /api/account/password",
  // The Server page, for Server admins only: the sign-up policy, mail status and account fields, never Workspace
  // data; a Server admin with no membership still reads no Workspace (server.test.ts, ADR 0024 rule 007).
  "GET /api/server/policy",
  "PUT /api/server/policy",
  "GET /api/server/mail-status",
  "GET /api/server/accounts",
  "POST /api/server/admins",
  "DELETE /api/server/admins/:userId",
  // Third-party plugin installs, for Server admins only: server-wide, never Workspace data (ADR 0026 rule 001);
  // routes.test.ts shows a Server admin with no membership gets 404 on a Workspace's plugin routes.
  "GET /api/server/plugins",
  "POST /api/server/plugins/review",
  "POST /api/server/plugins/confirm",
  "DELETE /api/server/plugins/:pluginId",
  "GET /api/connections/callback",
  // The link in an email: the token is the proof, and it opens only its own Workspace.
  "GET /api/unsubscribe/:workspaceId/:token",
  // A plugin reading an approved video: the signed token names one file in one Workspace and ends in minutes.
  "GET /api/media-links/:token",
  "POST /api/unsubscribe/:workspaceId/:token",
  // A connect link opened on another device: the token is the proof, used once, and opens only its own Workspace.
  "GET /api/connect/:workspaceId/:token",
  "POST /api/connect/:workspaceId/:token",
  // Another CRM adding relationship holds: the signature over the body is the proof, checked with the named Workspace's secret.
  "POST /api/hooks/holds/:workspaceId/:hookId",
  "POST /api/hooks/plugins/:workspaceId/:hookId",
  // A calendar fetching a review feed: the token is the proof, checked with the owner's membership on every read.
  "GET /api/feeds/review/:workspaceId/:file",
  // The door (ADR 0032): an External token for the Workspace in the URL is the proof, never a session,
  // and a token for another Workspace finds nothing. token-refusal.test.ts walks these routes.
  "POST /api/door/v1/w/:workspaceId/read_changes",
  "POST /api/door/v1/w/:workspaceId/read_needs_you",
  "POST /api/door/v1/w/:workspaceId/read_schedule",
  "POST /api/door/v1/w/:workspaceId/read_campaign",
  "POST /api/door/v1/w/:workspaceId/fact_proposal",
  "POST /api/door/v1/w/:workspaceId/draft",
  "POST /api/door/v1/w/:workspaceId/mcp",
  "GET /api/door/v1/w/:workspaceId/mcp",
  "DELETE /api/door/v1/w/:workspaceId/mcp",
  // The door's own OpenAPI document: its readers' shapes, no Workspace data.
  "GET /api/door/v1/openapi.json",
];

const a = await signIn();
const w1 = (await createOrg(a, "A")).workspace.id;
const b = await signIn();
const w2 = (await createOrg(b, "B")).workspace.id;
const bId = ((await (await call("/api/me", b)).json()) as { user: { id: string } }).user.id;
const invitee = `${crypto.randomUUID()}@example.com`;
const created = await call(`/api/w/${w2}/invites`, b, { method: "POST", body: { email: invitee, role: "marketer" } });
const inviteId = ((await created.json()) as { invite: { id: string } }).invite.id;
const secret = await app.request(`/api/w/${w2}/credentials`, {
  method: "POST",
  headers: { cookie: b, "content-type": "application/json" },
  body: JSON.stringify({ scope: "workspace", kind: "api_key", key: "w2-key", name: "W2", value: { key: "sk-w2" } }),
});
const credentialId = ((await secret.json()) as { credential: { id: string } }).credential.id;

const anyItem = crypto.randomUUID();
const fact = await app.request(`/api/w/${w2}/facts`, {
  method: "POST",
  headers: { cookie: b, "content-type": "application/json" },
  body: JSON.stringify({ field: "price", subject: "w2", value: "$1" }),
});
const factId = ((await fact.json()) as { id: string }).id;
const swap = await app.request(`/api/w/${w2}/voice/swaps`, {
  method: "POST",
  headers: { cookie: b, "content-type": "application/json" },
  body: JSON.stringify({ avoid: "users", prefer: "customers" }),
});
const voiceId = ((await swap.json()) as { id: string }).id;
// A non-public address, so its check is refused by the page reader and nothing is fetched.
const rival = await app.request(`/api/w/${w2}/competitors`, {
  method: "POST",
  headers: { cookie: b, "content-type": "application/json" },
  body: JSON.stringify({ name: "Rival", landingUrl: "http://127.0.0.1/" }),
});
const competitorId = ((await rival.json()) as { competitor: { id: string } }).competitor.id;
// A competitor proposal in W2, written straight to the table, since a scan needs the worker's agents.
const db = await ownerClient();
const proposalId = (
  await db.query(
    `with f as (insert into competitor_finds (workspace_id, kind, site, at) values ($1, 'own_site', 'https://w2.example/', now()) returning id)
     insert into competitor_proposals (workspace_id, find_id, name, name_key, found_at) select $1, id, 'Rival Two', 'rivaltwo', now() from f returning id`,
    [w2],
  )
).rows[0].id as string;
await db.end();
const plan = await app.request(`/api/w/${w2}/plans`, {
  method: "POST",
  headers: { cookie: b, "content-type": "application/json" },
  body: JSON.stringify({ title: "W2" }),
});
const planId = ((await plan.json()) as { id: string }).id;
const ideaReply = await app.request(`/api/w/${w2}/ideas`, {
  method: "POST",
  headers: { cookie: b, "content-type": "application/json" },
  body: JSON.stringify({ text: "W2's idea" }),
});
const ideaId = ((await ideaReply.json()) as { id: string }).id;
const cohort = await app.request(`/api/w/${w2}/prospecting/cohorts`, {
  method: "POST",
  headers: { cookie: b, "content-type": "application/json" },
  body: JSON.stringify({ name: "W2", filter: {} }),
});
const cohortId = ((await cohort.json()) as { id: string }).id;
const search = { terms: ["accountants"], limit: 1, signals: [] };
const tokenReply = await app.request(`/api/w/${w2}/external-tokens`, {
  method: "POST",
  headers: { cookie: b, "content-type": "application/json" },
  body: JSON.stringify({ name: "Isolation control", days: 7, readers: ["read_changes"], kinds: [] }),
});
expect(tokenReply.status).toBe(200);
const tokenId = ((await tokenReply.json()) as { id: string }).id;
const tokenState = async () => {
  const reply = await app.request(`/api/w/${w2}/external-tokens`, { headers: { cookie: b } });
  expect(reply.status).toBe(200);
  const { tokens } = (await reply.json()) as { tokens: { id: string; state: string }[] };
  return tokens.find((token) => token.id === tokenId)?.state;
};

// One request per Workspace route, against W2. Workspace deletion goes last.
const CASES: Record<string, { path: string; body?: unknown }> = {
  "GET /api/w/:workspaceId": { path: `/api/w/${w2}` },
  "GET /api/w/:workspaceId/members": { path: `/api/w/${w2}/members` },
  "PATCH /api/w/:workspaceId/members/:userId": { path: `/api/w/${w2}/members/${bId}`, body: { role: "viewer" } },
  "DELETE /api/w/:workspaceId/members/:userId": { path: `/api/w/${w2}/members/${bId}` },
  "GET /api/w/:workspaceId/invites": { path: `/api/w/${w2}/invites` },
  "POST /api/w/:workspaceId/invites": { path: `/api/w/${w2}/invites`, body: { email: "x@example.com", role: "viewer" } },
  "DELETE /api/w/:workspaceId/invites/:inviteId": { path: `/api/w/${w2}/invites/${inviteId}` },
  "GET /api/w/:workspaceId/audit": { path: `/api/w/${w2}/audit` },
  "POST /api/w/:workspaceId/connections/:connection/start": { path: `/api/w/${w2}/connections/google/start` },
  // No network has an app in this test, so a malformed name is what tells W2's Owner (400) from W1's member (404).
  "POST /api/w/:workspaceId/connections/:connection/links": { path: `/api/w/${w2}/connections/NOT_A_NETWORK/links` },
  "GET /api/w/:workspaceId/connect-links": { path: `/api/w/${w2}/connect-links` },
  "GET /api/w/:workspaceId/mailbox-providers": { path: `/api/w/${w2}/mailbox-providers` },
  "POST /api/w/:workspaceId/social/:connection/form": { path: `/api/w/${w2}/social/bluesky/form`, body: { username: "a", password: "b" } },
  "POST /api/w/:workspaceId/social/posts/preview": { path: `/api/w/${w2}/social/posts/preview`, body: { connection: "x", credentialId: null, networkId: null, text: "Hi" } },
  "GET /api/w/:workspaceId/social/posts": { path: `/api/w/${w2}/social/posts?campaignId=${anyItem}&stepKey=first` },
  "POST /api/w/:workspaceId/social/posts": { path: `/api/w/${w2}/social/posts`, body: { connection: "x", credentialId: null, networkId: null, text: "Hi", at: "2026-11-03T09:00:00Z" } },
  // That Item is no post, so blank words are what tell W2's Owner (400) from W1's member (404).
  "PUT /api/w/:workspaceId/social/posts/:itemId": { path: `/api/w/${w2}/social/posts/${anyItem}`, body: { text: " " } },
  "POST /api/w/:workspaceId/social/posts/:itemId/posted": { path: `/api/w/${w2}/social/posts/${anyItem}/posted`, body: { url: null } },
  "GET /api/w/:workspaceId/social/posts/:itemId/link-image": { path: `/api/w/${w2}/social/posts/${anyItem}/link-image` },
  "POST /api/w/:workspaceId/social/accounts/:accountId/removed": { path: `/api/w/${w2}/social/accounts/${anyItem}/removed`, body: { note: null } },
  "POST /api/w/:workspaceId/social/accounts/:accountId/unpause": { path: `/api/w/${w2}/social/accounts/${anyItem}/unpause` },
  "PUT /api/w/:workspaceId/social/accounts/:accountId/limits": { path: `/api/w/${w2}/social/accounts/${anyItem}/limits`, body: { links: 1 } },
  "PUT /api/w/:workspaceId/social/accounts/:accountId/about": { path: `/api/w/${w2}/social/accounts/${anyItem}/about`, body: { runBy: "Bio", angle: null } },
  "POST /api/w/:workspaceId/social/accounts/:accountId/established": { path: `/api/w/${w2}/social/accounts/${anyItem}/established` },
  "GET /api/w/:workspaceId/social/accounts/:accountId/pace": { path: `/api/w/${w2}/social/accounts/${anyItem}/pace` },
  "PUT /api/w/:workspaceId/social/accounts/:accountId/pace": { path: `/api/w/${w2}/social/accounts/${anyItem}/pace`, body: { postingFrom: 540, postingUntil: 1020, postingWeekends: false, gapMinutes: 90 } },
  "PUT /api/w/:workspaceId/campaigns/:id/steps/:key/posts": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/posts`, body: { plannedAt: "2026-11-03T09:00:00.000Z", targets: [{ connection: "x", credentialId: null, networkId: null, text: "Hi" }] } },
  "GET /api/w/:workspaceId/social/networks": { path: `/api/w/${w2}/social/networks` },
  "GET /api/w/:workspaceId/social/accounts": { path: `/api/w/${w2}/social/accounts` },
  "GET /api/w/:workspaceId/social/credentials/:credentialId/targets": { path: `/api/w/${w2}/social/credentials/${credentialId}/targets` },
  "POST /api/w/:workspaceId/social/credentials/:credentialId/targets": { path: `/api/w/${w2}/social/credentials/${credentialId}/targets`, body: { ids: ["x"] } },
  "DELETE /api/w/:workspaceId/social/credentials/:credentialId": { path: `/api/w/${w2}/social/credentials/${credentialId}` },
  "POST /api/w/:workspaceId/mailboxes/:connection": { path: `/api/w/${w2}/mailboxes/imap_smtp`, body: { username: "a@example.com", password: "pw", settings: {} } },
  "POST /api/w/:workspaceId/mailboxes/:credentialId/check": { path: `/api/w/${w2}/mailboxes/${credentialId}/check`, body: { probeWording: "2026-11-05" } },
  "GET /api/w/:workspaceId/outreach/mailbox-checks": { path: `/api/w/${w2}/outreach/mailbox-checks` },
  "GET /api/w/:workspaceId/outreach/mailbox-pauses": { path: `/api/w/${w2}/outreach/mailbox-pauses` },
  "GET /api/w/:workspaceId/credentials": { path: `/api/w/${w2}/credentials` },
  "POST /api/w/:workspaceId/credentials": {
    path: `/api/w/${w2}/credentials`,
    body: { scope: "user", kind: "api_key", key: "other", name: "O", value: { key: "sk" } },
  },
  "PUT /api/w/:workspaceId/credentials/:id/value": { path: `/api/w/${w2}/credentials/${credentialId}/value`, body: { version: 1, value: { key: "sk2" } } },
  "GET /api/w/:workspaceId/credentials/:id/events": { path: `/api/w/${w2}/credentials/${credentialId}/events` },
  "DELETE /api/w/:workspaceId/credentials/:id": { path: `/api/w/${w2}/credentials/${credentialId}` },
  // No worker runs here, so W2's Owner stops at the items module, past the Workspace check.
  "GET /api/w/:workspaceId/items": { path: `/api/w/${w2}/items` },
  "GET /api/w/:workspaceId/items/:id": { path: `/api/w/${w2}/items/${anyItem}` },
  "POST /api/w/:workspaceId/items/:id/approve": { path: `/api/w/${w2}/items/${anyItem}/approve`, body: { revision: 1 } },
  "POST /api/w/:workspaceId/items/approve-clean": { path: `/api/w/${w2}/items/approve-clean`, body: { items: [{ id: anyItem, revision: 1 }] } },
  "POST /api/w/:workspaceId/items/:id/cancel": { path: `/api/w/${w2}/items/${anyItem}/cancel` },
  "POST /api/w/:workspaceId/items/:id/resume": { path: `/api/w/${w2}/items/${anyItem}/resume` },
  "POST /api/w/:workspaceId/items/:id/undo": { path: `/api/w/${w2}/items/${anyItem}/undo` },
  "POST /api/w/:workspaceId/items/:id/resolve-unknown": { path: `/api/w/${w2}/items/${anyItem}/resolve-unknown`, body: { choice: "resend" } },
  "POST /api/w/:workspaceId/items/move": { path: `/api/w/${w2}/items/move`, body: { items: [{ id: anyItem, plannedAt: "2030-01-01T09:00:00Z" }] } },
  "PATCH /api/w/:workspaceId/items/:id/triage": { path: `/api/w/${w2}/items/${anyItem}/triage`, body: { snoozedUntil: null } },
  "POST /api/w/:workspaceId/lessons": { path: `/api/w/${w2}/lessons`, body: { agent: "recipient_writer", text: "Keep it short." } },
  "GET /api/w/:workspaceId/lessons": { path: `/api/w/${w2}/lessons` },
  "POST /api/w/:workspaceId/ask/messages": { path: `/api/w/${w2}/ask/messages`, body: { text: "What goes out this week?" } },
  "GET /api/w/:workspaceId/ask/messages": { path: `/api/w/${w2}/ask/messages` },
  "POST /api/w/:workspaceId/lessons/:id/rewrite": { path: `/api/w/${w2}/lessons/${anyItem}/rewrite`, body: { version: 1, text: "Keep it short." } },
  "POST /api/w/:workspaceId/lessons/:id/retire": { path: `/api/w/${w2}/lessons/${anyItem}/retire`, body: { version: 1 } },
  "POST /api/w/:workspaceId/lessons/:id/to-fact": { path: `/api/w/${w2}/lessons/${anyItem}/to-fact`, body: { version: 1, field: "tone", sourceLabel: "x" } },
  "GET /api/w/:workspaceId/standing-rules": { path: `/api/w/${w2}/standing-rules` },
  "GET /api/w/:workspaceId/standing-rules/coverage": { path: `/api/w/${w2}/standing-rules/coverage?campaignId=${anyItem}&stepKey=s` },
  "GET /api/w/:workspaceId/standing-rules/agent-written": { path: `/api/w/${w2}/standing-rules/agent-written?campaignId=${anyItem}&stepKey=s` },
  "POST /api/w/:workspaceId/standing-rules": { path: `/api/w/${w2}/standing-rules`, body: { campaignId: anyItem, stepKey: "s", dailyCap: 5 } },
  "POST /api/w/:workspaceId/standing-rules/:id/reconfirm": { path: `/api/w/${w2}/standing-rules/${anyItem}/reconfirm` },
  "POST /api/w/:workspaceId/standing-rules/:id/revoke": { path: `/api/w/${w2}/standing-rules/${anyItem}/revoke`, body: { reason: "Wrong list" } },
  "GET /api/w/:workspaceId/external-tokens": { path: `/api/w/${w2}/external-tokens` },
  "POST /api/w/:workspaceId/external-tokens": { path: `/api/w/${w2}/external-tokens`, body: { name: "Script", days: 7, readers: ["read_changes"], kinds: [] } },
  "DELETE /api/w/:workspaceId/external-tokens/:tokenId": { path: `/api/w/${w2}/external-tokens/${tokenId}` },
  "GET /api/w/:workspaceId/external-tokens/:tokenId/requests": { path: `/api/w/${w2}/external-tokens/${tokenId}/requests` },
  "GET /api/w/:workspaceId/models/connections": { path: `/api/w/${w2}/models/connections` },
  "PUT /api/w/:workspaceId/models/connections/:provider": { path: `/api/w/${w2}/models/connections/anthropic`, body: { credentialId } },
  "DELETE /api/w/:workspaceId/models/connections/:provider": { path: `/api/w/${w2}/models/connections/anthropic` },
  "POST /api/w/:workspaceId/models/connections/:provider/test": { path: `/api/w/${w2}/models/connections/anthropic/test` },
  "GET /api/w/:workspaceId/models/adapters": { path: `/api/w/${w2}/models/adapters` },
  "PUT /api/w/:workspaceId/models/adapter": { path: `/api/w/${w2}/models/adapter`, body: { adapter: "codex", model: null } },
  "PUT /api/w/:workspaceId/models/agents/:agent/adapter": { path: `/api/w/${w2}/models/agents/brand_reader/adapter`, body: { adapter: "codex", model: null } },
  "POST /api/w/:workspaceId/models/adapters/:adapter/sign-in/shared": { path: `/api/w/${w2}/models/adapters/codex/sign-in/shared` },
  "POST /api/w/:workspaceId/models/adapters/:adapter/sign-in/personal": { path: `/api/w/${w2}/models/adapters/codex/sign-in/personal` },
  "DELETE /api/w/:workspaceId/models/adapters/:adapter/sign-in/shared": { path: `/api/w/${w2}/models/adapters/codex/sign-in/shared` },
  "DELETE /api/w/:workspaceId/models/adapters/:adapter/sign-in/personal": { path: `/api/w/${w2}/models/adapters/codex/sign-in/personal` },
  "POST /api/w/:workspaceId/models/adapters/:adapter/test": { path: `/api/w/${w2}/models/adapters/codex/test` },
  "POST /api/w/:workspaceId/models/sign-ins/:id/finish": { path: `/api/w/${w2}/models/sign-ins/${crypto.randomUUID()}/finish`, body: { code: "x" } },
  "GET /api/w/:workspaceId/models/settings": { path: `/api/w/${w2}/models/settings` },
  "PUT /api/w/:workspaceId/models/settings": { path: `/api/w/${w2}/models/settings`, body: { monthlyBudgetMicros: "1000", allowUnpriced: false } },
  "GET /api/w/:workspaceId/models/usage": { path: `/api/w/${w2}/models/usage` },
  "GET /api/w/:workspaceId/models/calls": { path: `/api/w/${w2}/models/calls` },
  "GET /api/w/:workspaceId/facts": { path: `/api/w/${w2}/facts` },
  "POST /api/w/:workspaceId/facts": { path: `/api/w/${w2}/facts`, body: { field: "tone", value: "Plain" } },
  "POST /api/w/:workspaceId/facts/proposals": { path: `/api/w/${w2}/facts/proposals`, body: { field: "tone", value: "Short" } },
  "GET /api/w/:workspaceId/facts/:id/versions": { path: `/api/w/${w2}/facts/${factId}/versions` },
  "POST /api/w/:workspaceId/facts/:id/retire": { path: `/api/w/${w2}/facts/${factId}/retire` },
  "POST /api/w/:workspaceId/strategy/draft-run": { path: `/api/w/${w2}/strategy/draft-run`, body: { request: "x" } },
  "POST /api/w/:workspaceId/plans/:id/draft-run": { path: `/api/w/${w2}/plans/${planId}/draft-run` },
  "GET /api/w/:workspaceId/strategy": { path: `/api/w/${w2}/strategy` },
  "GET /api/w/:workspaceId/strategy/versions": { path: `/api/w/${w2}/strategy/versions` },
  "PUT /api/w/:workspaceId/strategy/draft": { path: `/api/w/${w2}/strategy/draft`, body: { revision: 0, body: {} } },
  "POST /api/w/:workspaceId/strategy/submit": { path: `/api/w/${w2}/strategy/submit`, body: { revision: 0 } },
  "GET /api/w/:workspaceId/plans": { path: `/api/w/${w2}/plans` },
  "POST /api/w/:workspaceId/plans": { path: `/api/w/${w2}/plans`, body: { title: "x" } },
  "GET /api/w/:workspaceId/plans/:id": { path: `/api/w/${w2}/plans/${planId}` },
  "GET /api/w/:workspaceId/plans/:id/versions": { path: `/api/w/${w2}/plans/${planId}/versions` },
  "GET /api/w/:workspaceId/plans/:id/campaign": { path: `/api/w/${w2}/plans/${planId}/campaign` },
  "PUT /api/w/:workspaceId/plans/:id/draft": { path: `/api/w/${w2}/plans/${planId}/draft`, body: { revision: 0, body: {} } },
  "POST /api/w/:workspaceId/plans/:id/submit": { path: `/api/w/${w2}/plans/${planId}/submit`, body: { revision: 0 } },
  "POST /api/w/:workspaceId/plans/:id/archive": { path: `/api/w/${w2}/plans/${planId}/archive` },
  "POST /api/w/:workspaceId/plans/:id/steps/:key/progress": { path: `/api/w/${w2}/plans/${planId}/steps/first/progress`, body: { status: "done" } },
  "POST /api/w/:workspaceId/plans/:id/measures/:key/readings": { path: `/api/w/${w2}/plans/${planId}/measures/m/readings`, body: { value: "1", observedOn: "2026-11-01" } },
  "POST /api/w/:workspaceId/agents/brand_reader/runs": { path: `/api/w/${w2}/agents/brand_reader/runs`, body: { text: "About us" } },
  "GET /api/w/:workspaceId/agents/runs": { path: `/api/w/${w2}/agents/runs` },
  "GET /api/w/:workspaceId/agents/runs/:id": { path: `/api/w/${w2}/agents/runs/${anyItem}` },
  "POST /api/w/:workspaceId/agents/runs/:id/cancel": { path: `/api/w/${w2}/agents/runs/${anyItem}/cancel` },
  "GET /api/w/:workspaceId/drafts/offer": { path: `/api/w/${w2}/drafts/offer?target=strategy` },
  "POST /api/w/:workspaceId/drafts/offer/:runId/:outputKey/use": { path: `/api/w/${w2}/drafts/offer/${anyItem}/plan/use`, body: { revision: 0 } },
  "POST /api/w/:workspaceId/drafts/offer/:runId/:outputKey/dismiss": { path: `/api/w/${w2}/drafts/offer/${anyItem}/plan/dismiss` },
  "GET /api/w/:workspaceId/agents/:agent/settings": { path: `/api/w/${w2}/agents/brand_reader/settings` },
  "PATCH /api/w/:workspaceId/agents/:agent/settings": { path: `/api/w/${w2}/agents/brand_reader/settings`, body: { enabled: true } },
  "GET /api/w/:workspaceId/prospecting/companies": { path: `/api/w/${w2}/prospecting/companies` },
  "GET /api/w/:workspaceId/prospecting/estimate/per-company": { path: `/api/w/${w2}/prospecting/estimate/per-company` },
  "GET /api/w/:workspaceId/prospecting/runs": { path: `/api/w/${w2}/prospecting/runs` },
  "GET /api/w/:workspaceId/prospecting/runs/:id": { path: `/api/w/${w2}/prospecting/runs/${anyItem}` },
  "POST /api/w/:workspaceId/prospecting/runs/:id/check-again": { path: `/api/w/${w2}/prospecting/runs/${anyItem}/check-again` },
  "POST /api/w/:workspaceId/prospecting/runs/pasted": { path: `/api/w/${w2}/prospecting/runs/pasted`, body: { websites: [], signals: [], confirmedUsd: 0 } },
  "POST /api/w/:workspaceId/prospecting/estimate": { path: `/api/w/${w2}/prospecting/estimate`, body: search },
  "POST /api/w/:workspaceId/prospecting/runs": { path: `/api/w/${w2}/prospecting/runs`, body: { ...search, confirmedUsd: 0 } },
  "GET /api/w/:workspaceId/prospecting/terms": { path: `/api/w/${w2}/prospecting/terms` },
  "POST /api/w/:workspaceId/prospecting/terms": { path: `/api/w/${w2}/prospecting/terms` },
  "GET /api/w/:workspaceId/prospecting/cohorts": { path: `/api/w/${w2}/prospecting/cohorts` },
  "POST /api/w/:workspaceId/prospecting/cohorts": { path: `/api/w/${w2}/prospecting/cohorts`, body: { name: "x", filter: {} } },
  "POST /api/w/:workspaceId/prospecting/cohorts/count": { path: `/api/w/${w2}/prospecting/cohorts/count`, body: { filter: {} } },
  "GET /api/w/:workspaceId/prospecting/cohorts/:id": { path: `/api/w/${w2}/prospecting/cohorts/${cohortId}` },
  "PUT /api/w/:workspaceId/prospecting/cohorts/:id": { path: `/api/w/${w2}/prospecting/cohorts/${cohortId}`, body: { name: "y", filter: {} } },
  "POST /api/w/:workspaceId/prospecting/cohorts/:id/add-to-campaign": { path: `/api/w/${w2}/prospecting/cohorts/${cohortId}/add-to-campaign`, body: { campaignId: anyItem } },
  "POST /api/w/:workspaceId/prospecting/cohorts/:id/add-to-campaign/preview": { path: `/api/w/${w2}/prospecting/cohorts/${cohortId}/add-to-campaign/preview`, body: { campaignId: anyItem } },
  "GET /api/w/:workspaceId/prospecting/handovers/:id": { path: `/api/w/${w2}/prospecting/handovers/${anyItem}` },
  "GET /api/w/:workspaceId/key-services": { path: `/api/w/${w2}/key-services` },
  "GET /api/w/:workspaceId/plugins": { path: `/api/w/${w2}/plugins` },
  "PUT /api/w/:workspaceId/plugins/:pluginId": { path: `/api/w/${w2}/plugins/com.example.hello` },
  "DELETE /api/w/:workspaceId/plugins/:pluginId": { path: `/api/w/${w2}/plugins/com.example.hello` },
  "GET /api/w/:workspaceId/plugin-webhooks": { path: `/api/w/${w2}/plugin-webhooks` },
  "POST /api/w/:workspaceId/plugin-webhooks": { path: `/api/w/${w2}/plugin-webhooks`, body: { pluginId: "com.example.hello", trigger: "hello.hook" } },
  "POST /api/w/:workspaceId/plugin-webhooks/:hookId/rotate": { path: `/api/w/${w2}/plugin-webhooks/${anyItem}/rotate` },
  "POST /api/w/:workspaceId/key-services/:connection": { path: `/api/w/${w2}/key-services/reoon`, body: { key: "k" } },
  "PUT /api/w/:workspaceId/key-services/:connection": { path: `/api/w/${w2}/key-services/reoon`, body: { key: "k" } },
  "POST /api/w/:workspaceId/key-services/:connection/check": { path: `/api/w/${w2}/key-services/reoon/check` },
  "GET /api/w/:workspaceId/outreach": { path: `/api/w/${w2}/outreach` },
  "GET /api/w/:workspaceId/outreach/results": { path: `/api/w/${w2}/outreach/results` },
  "GET /api/w/:workspaceId/outreach/reply-count": { path: `/api/w/${w2}/outreach/reply-count?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z` },
  "PUT /api/w/:workspaceId/outreach/identity": { path: `/api/w/${w2}/outreach/identity`, body: { senderName: "W2", postalAddress: "1 Main St" } },
  "PUT /api/w/:workspaceId/outreach/pause": { path: `/api/w/${w2}/outreach/pause`, body: { paused: false } },
  "PUT /api/w/:workspaceId/outreach/mailboxes/:credentialId/pause": { path: `/api/w/${w2}/outreach/mailboxes/${anyItem}/pause`, body: { paused: true } },
  "GET /api/w/:workspaceId/newsletter/settings": { path: `/api/w/${w2}/newsletter/settings` },
  "PUT /api/w/:workspaceId/newsletter/settings": { path: `/api/w/${w2}/newsletter/settings`, body: { list: "substack", credentialId: null, weekday: 2, sendTime: "09:00", timeZone: "UTC", enabled: false } },
  "GET /api/w/:workspaceId/newsletter/issues": { path: `/api/w/${w2}/newsletter/issues` },
  "GET /api/w/:workspaceId/newsletter/issues/:itemId": { path: `/api/w/${w2}/newsletter/issues/${anyItem}` },
  "PUT /api/w/:workspaceId/newsletter/issues/:itemId": { path: `/api/w/${w2}/newsletter/issues/${anyItem}`, body: { title: "x", markdown: "y" } },
  "POST /api/w/:workspaceId/newsletter/issues/:itemId/submit": { path: `/api/w/${w2}/newsletter/issues/${anyItem}/submit` },
  "POST /api/w/:workspaceId/newsletter/issues/:itemId/sent": { path: `/api/w/${w2}/newsletter/issues/${anyItem}/sent` },
  "POST /api/w/:workspaceId/newsletter/preview": { path: `/api/w/${w2}/newsletter/preview`, body: { markdown: "x" } },
  "GET /api/w/:workspaceId/newsletter/keys/:credentialId/lists": { path: `/api/w/${w2}/newsletter/keys/${anyItem}/lists` },
  "PUT /api/w/:workspaceId/newsletter/keys/:credentialId/list": { path: `/api/w/${w2}/newsletter/keys/${anyItem}/list`, body: { listId: "a1" } },
  "GET /api/w/:workspaceId/seo/search-console": { path: `/api/w/${w2}/seo/search-console` },
  "POST /api/w/:workspaceId/seo/search-console/property": { path: `/api/w/${w2}/seo/search-console/property`, body: { siteUrl: "sc-domain:example.com" } },
  "GET /api/w/:workspaceId/seo/search-console/summary": { path: `/api/w/${w2}/seo/search-console/summary` },
  "GET /api/w/:workspaceId/seo/candidates": { path: `/api/w/${w2}/seo/candidates` },
  "GET /api/w/:workspaceId/seo/briefs": { path: `/api/w/${w2}/seo/briefs` },
  "POST /api/w/:workspaceId/seo/briefs/run": { path: `/api/w/${w2}/seo/briefs/run` },
  "GET /api/w/:workspaceId/seo/briefs/history": { path: `/api/w/${w2}/seo/briefs/history` },
  "POST /api/w/:workspaceId/seo/briefs/write": { path: `/api/w/${w2}/seo/briefs/write`, body: { page: "https://example.com/a", query: "a" } },
  "POST /api/w/:workspaceId/outreach/people": { path: `/api/w/${w2}/outreach/people`, body: { email: "kim@example.com", country: "US", basis: "consent", evidence: "form" } },
  "GET /api/w/:workspaceId/outreach/people/:personId": { path: `/api/w/${w2}/outreach/people/${anyItem}` },
  "POST /api/w/:workspaceId/outreach/people/:personId/outside-touches": { path: `/api/w/${w2}/outreach/people/${anyItem}/outside-touches`, body: { channel: "call", direction: "outbound", occurredAt: "2026-11-01T09:00:00Z" } },
  "GET /api/w/:workspaceId/outreach/people/:personId/outside-touches": { path: `/api/w/${w2}/outreach/people/${anyItem}/outside-touches` },
  "DELETE /api/w/:workspaceId/outreach/people/:personId/outside-touches/:id": { path: `/api/w/${w2}/outreach/people/${anyItem}/outside-touches/${anyItem}` },
  "GET /api/w/:workspaceId/outreach/people/:personId/holds": { path: `/api/w/${w2}/outreach/people/${anyItem}/holds` },
  "POST /api/w/:workspaceId/outreach/people/:personId/holds": { path: `/api/w/${w2}/outreach/people/${anyItem}/holds`, body: { reason: "Deal" } },
  "POST /api/w/:workspaceId/outreach/people/:personId/holds/release": { path: `/api/w/${w2}/outreach/people/${anyItem}/holds/release`, body: { kind: "inferred" } },
  "POST /api/w/:workspaceId/outreach/people/:personId/undo-opt-out": { path: `/api/w/${w2}/outreach/people/${anyItem}/undo-opt-out`, body: { reason: "misread" } },
  "POST /api/w/:workspaceId/outreach/holds/:holdId/end": { path: `/api/w/${w2}/outreach/holds/${anyItem}/end` },
  "GET /api/w/:workspaceId/outreach/hold-hook": { path: `/api/w/${w2}/outreach/hold-hook` },
  "POST /api/w/:workspaceId/outreach/hold-hook": { path: `/api/w/${w2}/outreach/hold-hook` },
  "POST /api/w/:workspaceId/outreach/hold-hook/:hookId/rotate": { path: `/api/w/${w2}/outreach/hold-hook/${anyItem}/rotate` },
  "POST /api/w/:workspaceId/outreach/people/:personId/profiles": { path: `/api/w/${w2}/outreach/people/${anyItem}/profiles`, body: { kind: "linkedin", url: "linkedin.com/in/kim" } },
  "PUT /api/w/:workspaceId/campaigns/:id/steps/:key/dm-text": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/dm-text`, body: { revision: 0, text: "Hi" } },
  "POST /api/w/:workspaceId/campaigns/:id/steps/:key/dms": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/dms` },
  "GET /api/w/:workspaceId/campaigns/:id/steps/:key/dms": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/dms` },
  "POST /api/w/:workspaceId/campaigns/dms/:dmId/copied": { path: `/api/w/${w2}/campaigns/dms/${anyItem}/copied` },
  "POST /api/w/:workspaceId/campaigns/dms/:dmId/mark-sent": { path: `/api/w/${w2}/campaigns/dms/${anyItem}/mark-sent` },
  "POST /api/w/:workspaceId/outreach/suppressions": { path: `/api/w/${w2}/outreach/suppressions`, body: { email: "gone@example.com" } },
  "GET /api/w/:workspaceId/outreach/replies/:signalId": { path: `/api/w/${w2}/outreach/replies/${anyItem}` },
  "POST /api/w/:workspaceId/outreach/emails": { path: `/api/w/${w2}/outreach/emails`, body: { personId: anyItem, credentialId: anyItem, touchClass: "cold", subject: "Hi", text: "Hi" } },
  "PUT /api/w/:workspaceId/campaigns/:id/drafting-mode": { path: `/api/w/${w2}/campaigns/${anyItem}/drafting-mode`, body: { mode: "template" } },
  "GET /api/w/:workspaceId/campaigns/:id/drafting-preview": { path: `/api/w/${w2}/campaigns/${anyItem}/drafting-preview` },
  "GET /api/w/:workspaceId/campaigns/:id/progress": { path: `/api/w/${w2}/campaigns/${anyItem}/progress` },
  "GET /api/w/:workspaceId/campaigns/:id/results": { path: `/api/w/${w2}/campaigns/${anyItem}/results` },
  "GET /api/w/:workspaceId/campaigns/:id/overlaps": { path: `/api/w/${w2}/campaigns/${anyItem}/overlaps` },
  "GET /api/w/:workspaceId/campaigns/:id/write-up": { path: `/api/w/${w2}/campaigns/${anyItem}/write-up` },
  "POST /api/w/:workspaceId/campaigns/:id/write-up": { path: `/api/w/${w2}/campaigns/${anyItem}/write-up` },
  "GET /api/w/:workspaceId/campaigns/:id/activity": { path: `/api/w/${w2}/campaigns/${anyItem}/activity` },
  "DELETE /api/w/:workspaceId/campaigns/:id/draft": { path: `/api/w/${w2}/campaigns/${anyItem}/draft` },
  "PUT /api/w/:workspaceId/campaigns/:id/anchor": { path: `/api/w/${w2}/campaigns/${anyItem}/anchor`, body: { on: "2030-01-07" } },
  "POST /api/w/:workspaceId/campaigns/:id/steps/:key/stall": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/stall`, body: { choice: "wait" } },
  "POST /api/w/:workspaceId/campaigns/:id/drafting-confirm": { path: `/api/w/${w2}/campaigns/${anyItem}/drafting-confirm`, body: { timeZone: "UTC" } },
  "PUT /api/w/:workspaceId/campaigns/:id/steps/:key/drafting-mode": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/drafting-mode`, body: { mode: "template" } },
  "POST /api/w/:workspaceId/campaigns/:id/outside-content": { path: `/api/w/${w2}/campaigns/${anyItem}/outside-content`, body: { allowed: true } },
  "POST /api/w/:workspaceId/campaigns/:id/advance": { path: `/api/w/${w2}/campaigns/${anyItem}/advance`, body: { advance: "run", timeZone: "UTC" } },
  "POST /api/w/:workspaceId/campaigns/:id/steps/:key/draft-run": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/draft-run` },
  "PUT /api/w/:workspaceId/campaigns/:id/steps/:key/template": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/template`, body: { revision: 0, subject: "Hi", text: "Hi" } },
  "POST /api/w/:workspaceId/campaigns/:id/steps/:key/make-drafts": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/make-drafts`, body: { timeZone: "UTC" } },
  "POST /api/w/:workspaceId/campaigns/:id/steps/:key/output": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/output`, body: { url: "https://acme.test/launch" } },
  "GET /api/w/:workspaceId/campaigns/:id/steps/:key/drafts-preview": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/drafts-preview` },
  "GET /api/w/:workspaceId/campaigns/:id/steps/:key/person-preview": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/person-preview` },
  "POST /api/w/:workspaceId/campaigns/:id/steps/:key/write-per-person": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/write-per-person`, body: { timeZone: "UTC" } },
  "GET /api/w/:workspaceId/campaigns/:id/steps/:key/person-drafts": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/person-drafts` },
  "GET /api/w/:workspaceId/campaigns/:id/steps/:key/repeated-edits": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/repeated-edits` },
  "GET /api/w/:workspaceId/campaigns/:id/steps/:key/repeated-reasons": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/repeated-reasons` },
  "GET /api/w/:workspaceId/docs": { path: `/api/w/${w2}/docs` },
  "GET /api/w/:workspaceId/docs/pages": { path: `/api/w/${w2}/docs/pages` },
  "GET /api/w/:workspaceId/docs/databases": { path: `/api/w/${w2}/docs/databases` },
  "GET /api/w/:workspaceId/docs/databases/:databaseId": { path: `/api/w/${w2}/docs/databases/${anyItem}` },
  "PUT /api/w/:workspaceId/docs/databases/:databaseId/mapping": { path: `/api/w/${w2}/docs/databases/${anyItem}/mapping`, body: { date: "Date", channel: "Channel", text: { page: true }, accounts: {} } },
  "POST /api/w/:workspaceId/docs/sources/:sourceId/preview": { path: `/api/w/${w2}/docs/sources/${anyItem}/preview` },
  "POST /api/w/:workspaceId/docs/sources/:sourceId/import": { path: `/api/w/${w2}/docs/sources/${anyItem}/import` },
  "POST /api/w/:workspaceId/docs/pages/:pageId/read": { path: `/api/w/${w2}/docs/pages/${anyItem}/read` },
  "GET /api/w/:workspaceId/docs/sources": { path: `/api/w/${w2}/docs/sources` },
  "GET /api/w/:workspaceId/docs/sources/:sourceId/write-back": { path: `/api/w/${w2}/docs/sources/${anyItem}/write-back` },
  "PUT /api/w/:workspaceId/docs/sources/:sourceId/write-back": { path: `/api/w/${w2}/docs/sources/${anyItem}/write-back`, body: { statusPropertyId: "Status", statusType: "status", options: { sent: "opt-Sent" } } },
  "POST /api/w/:workspaceId/docs/sources/:sourceId/write-back/grant": { path: `/api/w/${w2}/docs/sources/${anyItem}/write-back/grant`, body: { answer: "yes", wordingVersion: "2026-11-14" } },
  "POST /api/w/:workspaceId/docs/sources/:sourceId/write-back/stop": { path: `/api/w/${w2}/docs/sources/${anyItem}/write-back/stop`, body: { reason: "Stop" } },
  "GET /api/w/:workspaceId/ideas": { path: `/api/w/${w2}/ideas` },
  "POST /api/w/:workspaceId/ideas": { path: `/api/w/${w2}/ideas`, body: { text: "Webinar" } },
  "POST /api/w/:workspaceId/ideas/:id/dismiss": { path: `/api/w/${w2}/ideas/${ideaId}/dismiss` },
  "POST /api/w/:workspaceId/ideas/:id/started": { path: `/api/w/${w2}/ideas/${ideaId}/started`, body: { planId } },
  "PUT /api/w/:workspaceId/campaigns/:id/notes": { path: `/api/w/${w2}/campaigns/${anyItem}/notes`, body: { notes: "Context", revision: 0 } },
  "PUT /api/w/:workspaceId/campaigns/:id/steps/:key/writer-notes": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/writer-notes`, body: { notes: "Shorter", revision: 0 } },
  "POST /api/w/:workspaceId/campaigns/:id/steps/:key/redraft": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/redraft`, body: { confirm: false, timeZone: "UTC" } },
  "POST /api/w/:workspaceId/items/:id/rewrite": { path: `/api/w/${w2}/items/${anyItem}/rewrite`, body: { preset: "shorter", timeZone: "UTC" } },
  "GET /api/w/:workspaceId/voice": { path: `/api/w/${w2}/voice` },
  "POST /api/w/:workspaceId/voice/swaps": { path: `/api/w/${w2}/voice/swaps`, body: { avoid: "users", prefer: "customers" } },
  "POST /api/w/:workspaceId/voice/examples": { path: `/api/w/${w2}/voice/examples`, body: { text: "We write plainly." } },
  "POST /api/w/:workspaceId/voice/:id/retire": { path: `/api/w/${w2}/voice/${voiceId}/retire` },
  "GET /api/w/:workspaceId/competitors": { path: `/api/w/${w2}/competitors` },
  "POST /api/w/:workspaceId/competitors": { path: `/api/w/${w2}/competitors`, body: { name: "Rival", landingUrl: "http://127.0.0.1/" } },
  "PATCH /api/w/:workspaceId/competitors/:id": { path: `/api/w/${w2}/competitors/${competitorId}`, body: { name: "Rival 2" } },
  "POST /api/w/:workspaceId/competitors/:id/check": { path: `/api/w/${w2}/competitors/${competitorId}/check` },
  "POST /api/w/:workspaceId/competitors/find-pages": { path: `/api/w/${w2}/competitors/find-pages`, body: { landingUrl: "http://127.0.0.1/" } },
  "GET /api/w/:workspaceId/competitors/proposals": { path: `/api/w/${w2}/competitors/proposals` },
  "POST /api/w/:workspaceId/competitors/proposals/scan": { path: `/api/w/${w2}/competitors/proposals/scan` },
  "POST /api/w/:workspaceId/competitors/proposals/search": { path: `/api/w/${w2}/competitors/proposals/search`, body: { terms: ["bank reconciliation software"] } },
  "POST /api/w/:workspaceId/competitors/proposals/:id/dismiss": { path: `/api/w/${w2}/competitors/proposals/${proposalId}/dismiss` },
  "GET /api/w/:workspaceId/competitors/:id/changes": { path: `/api/w/${w2}/competitors/${competitorId}/changes` },
  // Last of the four: W2's Owner removes the row the cases above use.
  "DELETE /api/w/:workspaceId/competitors/:id": { path: `/api/w/${w2}/competitors/${competitorId}` },
  "GET /api/w/:workspaceId/review-rates":{ path: `/api/w/${w2}/review-rates` },
  "PUT /api/w/:workspaceId/campaigns/:id/steps/:key/people/:personId/draft": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/people/${anyItem}/draft`, body: { subject: "Hi", text: "Hi" } },
  "POST /api/w/:workspaceId/campaigns/:id/pause": { path: `/api/w/${w2}/campaigns/${anyItem}/pause` },
  "POST /api/w/:workspaceId/campaigns/:id/resume": { path: `/api/w/${w2}/campaigns/${anyItem}/resume` },
  "GET /api/w/:workspaceId/campaigns": { path: `/api/w/${w2}/campaigns` },
  "GET /api/w/:workspaceId/campaign-launches": { path: `/api/w/${w2}/campaign-launches?from=2026-11-01&to=2026-11-30` },
  "GET /api/w/:workspaceId/campaign-steps": { path: `/api/w/${w2}/campaign-steps?from=2026-11-01&to=2026-11-30` },
  "GET /api/w/:workspaceId/campaigns/:id": { path: `/api/w/${w2}/campaigns/${anyItem}` },
  "GET /api/w/:workspaceId/campaigns/:id/people": { path: `/api/w/${w2}/campaigns/${anyItem}/people` },
  "GET /api/w/:workspaceId/campaigns/:id/plan-impact": { path: `/api/w/${w2}/campaigns/${anyItem}/plan-impact` },
  "POST /api/w/:workspaceId/campaigns/:id/people": { path: `/api/w/${w2}/campaigns/${anyItem}/people`, body: { csv: "email\nkim@example.com" } },
  "POST /api/w/:workspaceId/campaigns/:id/outcomes": { path: `/api/w/${w2}/campaigns/${anyItem}/outcomes`, body: { personId: anyItem, kind: "meeting", on: "2026-11-01" } },
  "POST /api/w/:workspaceId/campaigns/:id/outcomes/:markId/undo": { path: `/api/w/${w2}/campaigns/${anyItem}/outcomes/${anyItem}/undo` },
  "DELETE /api/w/:workspaceId/campaigns/:id/people/:personId": { path: `/api/w/${w2}/campaigns/${anyItem}/people/${anyItem}` },
  "PUT /api/w/:workspaceId/campaigns/:id/steps/:key": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first`, body: { type: "manual", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" } },
  "POST /api/w/:workspaceId/media": { path: `/api/w/${w2}/media?kind=source`, body: { not: "a video" } },
  "GET /api/w/:workspaceId/media/:id": { path: `/api/w/${w2}/media/${anyItem}` },
  "DELETE /api/w/:workspaceId/media/:id": { path: `/api/w/${w2}/media/${anyItem}` },
  "PUT /api/w/:workspaceId/campaigns/:id/steps/:key/clips": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/clips`, body: { sourceMediaId: anyItem, accounts: [{ connection: "linkedin", credentialId: null, networkId: null }], firstAt: "2026-11-09T09:00:00Z" } },
  "GET /api/w/:workspaceId/campaigns/:id/steps/:key/clips": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/clips` },
  "PUT /api/w/:workspaceId/campaigns/:id/steps/:key/brief": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/brief`, body: { page: "https://acme.test/pricing", query: "acme pricing" } },
  "GET /api/w/:workspaceId/campaigns/:id/steps/:key/brief": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/brief` },
  "PUT /api/w/:workspaceId/campaigns/:id/steps/:key/clips/:clipId/caption": { path: `/api/w/${w2}/campaigns/${anyItem}/steps/first/clips/${anyItem}/caption`, body: { text: "Hi" } },
  "POST /api/w/:workspaceId/clip-runs": { path: `/api/w/${w2}/clip-runs`, body: { mediaId: anyItem } },
  "GET /api/w/:workspaceId/clip-runs/:id": { path: `/api/w/${w2}/clip-runs/${anyItem}` },
  "GET /api/w/:workspaceId/mailboxes/:credentialId/pace": { path: `/api/w/${w2}/mailboxes/${anyItem}/pace` },
  "PUT /api/w/:workspaceId/mailboxes/:credentialId/pace": { path: `/api/w/${w2}/mailboxes/${anyItem}/pace`, body: { dailyLimit: 50, sendFrom: 540, sendUntil: 1020, sendWeekends: false } },
  "GET /api/w/:workspaceId/mailboxes/:credentialId/placement": { path: `/api/w/${w2}/mailboxes/${credentialId}/placement` },
  "POST /api/w/:workspaceId/mailboxes/:credentialId/placement": { path: `/api/w/${w2}/mailboxes/${credentialId}/placement`, body: { answer: "yes", wordingVersion: "2026-11-10", confirmAddress: "a@example.com" } },
  "POST /api/w/:workspaceId/mailboxes/:credentialId/placement/stop": { path: `/api/w/${w2}/mailboxes/${credentialId}/placement/stop`, body: { reason: "Stop" } },
  "GET /api/w/:workspaceId/mailboxes/:credentialId/placement/results": { path: `/api/w/${w2}/mailboxes/${credentialId}/placement/results` },
  "POST /api/w/:workspaceId/mailboxes/:credentialId/placement/join": { path: `/api/w/${w2}/mailboxes/${credentialId}/placement/join`, body: { part1: "a".repeat(22), part2: "b".repeat(22), signer: "signer@example.com", messageId: "<p1@mail.gmail.com>" } },
  "GET /api/w/:workspaceId/time-zone": { path: `/api/w/${w2}/time-zone` },
  "PUT /api/w/:workspaceId/time-zone": { path: `/api/w/${w2}/time-zone`, body: { timeZone: "UTC" } },
  // The link comes first, so the Owner's PUT and DELETE find a feed to change and stop.
  "POST /api/w/:workspaceId/review-feed/link": { path: `/api/w/${w2}/review-feed/link`, body: { weekdays: [2], startMinute: 600, lengthMinutes: 30, timeZone: "UTC" } },
  "GET /api/w/:workspaceId/review-feed": { path: `/api/w/${w2}/review-feed` },
  "PUT /api/w/:workspaceId/review-feed": { path: `/api/w/${w2}/review-feed`, body: { weekdays: [2], startMinute: 600, lengthMinutes: 30, timeZone: "UTC" } },
  "DELETE /api/w/:workspaceId/review-feed": { path: `/api/w/${w2}/review-feed` },
  "GET /api/w/:workspaceId/tracking/domains": { path: `/api/w/${w2}/tracking/domains` },
  "POST /api/w/:workspaceId/tracking/domains": { path: `/api/w/${w2}/tracking/domains`, body: { hostname: "links.example.com" } },
  "POST /api/w/:workspaceId/tracking/domains/:id/check": { path: `/api/w/${w2}/tracking/domains/${crypto.randomUUID()}/check` },
  "POST /api/w/:workspaceId/tracking/domains/:id/stop": { path: `/api/w/${w2}/tracking/domains/${crypto.randomUUID()}/stop` },
  "DELETE /api/w/:workspaceId/tracking/domains/:id": { path: `/api/w/${w2}/tracking/domains/${crypto.randomUUID()}` },
  "GET /api/w/:workspaceId/mailbox-days": { path: `/api/w/${w2}/mailbox-days?from=2026-11-02T00:00:00.000Z&to=2026-11-09T00:00:00.000Z` },
  // A Workspace's export sits outside /api/w/ so its Owner reaches it after deleting it (ADR 0030 rule 008).
  "GET /api/exports/:workspaceId": { path: `/api/exports/${w2}` },
  "POST /api/exports/:workspaceId": { path: `/api/exports/${w2}` },
  "GET /api/exports/:workspaceId/:id": { path: `/api/exports/${w2}/${anyItem}` },
  "DELETE /api/w/:workspaceId": { path: `/api/w/${w2}` },
};

const send = (key: string, cookie: string) => {
  const { path, body } = CASES[key]!;
  return app.request(path, {
    method: key.split(" ")[0],
    headers: { cookie, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
};

test("every mounted route has a case here or is listed as taking no Workspace", () => {
  const mounted = [...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))];
  const inWorkspace = (k: string) => k.includes("/api/w/:workspaceId") || k.includes("/api/exports/:workspaceId");
  expect(mounted.filter(inWorkspace).sort()).toEqual(Object.keys(CASES).sort());
  expect(mounted.filter((k) => !inWorkspace(k)).sort()).toEqual([...OUTSIDE].sort());
});

test("W2's invite token does nothing for a session with another email, or for W1", async () => {
  const token = inviteToken(invitee);
  const accept = (workspaceId: string) =>
    app.request("/api/invites/accept", {
      method: "POST",
      headers: { cookie: a, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, token }),
    });
  expect((await accept(w2)).status).toBe(403);
  expect((await accept(w1)).status).toBe(404);
  expect((await app.request(`/api/w/${w2}`, { headers: { cookie: a } })).status).toBe(404);
});

test("a member of W1 gets 404 on every W2 route; W2's Owner does not", async () => {
  for (const key of Object.keys(CASES)) expect((await send(key, a)).status, key).toBe(404);
  expect(await tokenState()).toBe("live");
  // Proves each case reaches its route: W2's Owner gets past the Workspace check.
  for (const key of Object.keys(CASES)) {
    // A Person the route doesn't know is its own 404, inside the Workspace, so give the Owner a real refusal.
    // So is a key W2 never stored, which is all replacing and checking one can reach with no worker's plugins.
    if (key.endsWith("/outreach/emails") || key.includes("/outreach/replies/") || key.includes("/outreach/people/:personId") || key.includes("/outreach/holds/:holdId") || key.includes("/outreach/hold-hook/:hookId") || key.includes("/campaigns/:id") || key.includes("/campaigns/dms/:dmId") || key.includes("/prospecting/runs/:id") || key.includes("/newsletter/issues/:itemId") || key.includes("/newsletter/keys/:credentialId") || key.includes("/social/accounts/:accountId") || key.includes("/media/:id") || key.endsWith("/link-image") || key.includes("/mailboxes/:credentialId/pace") || key.includes("/outreach/mailboxes/:credentialId/pause") || key.includes("/mailboxes/:credentialId/placement")) continue;
    // A docs source W2 never imported is its own 404; saving its mapping is refused first as not connected.
    if (key.includes("/docs/sources/:sourceId/write-back") && !key.startsWith("PUT ")) continue;
    if (key === "PUT /api/w/:workspaceId/key-services/:connection" || key.endsWith("/key-services/:connection/check")) continue;
    // A plugin this server never installed is its own 404 inside the Workspace (ADR 0026).
    if (key === "PUT /api/w/:workspaceId/plugins/:pluginId") continue;
    // A trigger no loaded plugin declares, and a webhook W2 never made, are their own 404s (ADR 0031).
    if (key === "POST /api/w/:workspaceId/plugin-webhooks" || key.includes("/plugin-webhooks/:hookId")) continue;
    // An export W2 never made is its own 404; starting one needs the worker's queue, which this test doesn't start.
    if (key.startsWith("POST /api/exports/") || key === "GET /api/exports/:workspaceId/:id") continue;
    // A tracking domain W2 never added is its own 404 (ADR 0035).
    if (key.includes("/tracking/domains/:id")) continue;
    const reply = await send(key, b);
    expect([401, 404], key).not.toContain(reply.status);
    if (key === "DELETE /api/w/:workspaceId/external-tokens/:tokenId") {
      expect([reply.status, await reply.json()]).toEqual([200, { ok: true }]);
      expect(await tokenState()).toBe("revoked");
    }
  }
  expect((await app.request(`/api/w/${w1}`, { headers: { cookie: a } })).status).toBe(200);
});

test("a request that fails a route's schema gets one {error} body, on every module, never the raw schema error", async () => {
  for (const [path, init] of [[`/api/w/${w1}/campaigns/not-a-uuid`, {}], [`/api/w/${w1}/time-zone`, { method: "PUT", body: "{}" }], [`/api/w/${w1}/outreach/identity`, { method: "PUT", body: "{}" }]] as const) {
    const r = await app.request(path, { ...init, headers: { cookie: a, "content-type": "application/json" } });
    expect([r.status, Object.keys((await r.json()) as object)], path).toEqual([400, ["error"]]);
  }
});
