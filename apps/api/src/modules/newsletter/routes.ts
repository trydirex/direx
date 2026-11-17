// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requirePermission, type MemberEnv } from "../identity/index";
import type { IssueDesk, IssueView } from "./application/issues";
import { renderIssue } from "./domain/render";
import type { Newsletter } from "./application/settings";

const ErrorBody = z.object({ error: z.string() }).openapi("NewsletterError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const errors = { 400: json(ErrorBody, "Invalid request"), 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not allowed"), 404: json(ErrorBody, "Not found"), 409: json(ErrorBody, "Refused, with a named reason") };
const ws = z.object({ workspaceId: z.uuid() });

const Settings = z
  .object({
    list: z.enum(["connected", "substack"]),
    credentialId: z.uuid().nullable(),
    /** Monday 1 to Sunday 7. */
    weekday: z.number().int().min(1).max(7),
    sendTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
    timeZone: z.string().min(1).max(100),
    enabled: z.boolean(),
  })
  .openapi("NewsletterSettingsInput");
const SettingsView = Settings.extend({
  readOnlySince: z.string().nullable(),
  /** Shown as "read-only: needs beehiiv Pro". Issues are handoffs until the key is replaced. */
  readOnlyReason: z.string().nullable(),
  lastSentAt: z.string().nullable(),
}).openapi("NewsletterSettings");

const getRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/newsletter/settings",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: {
    200: json(
      z.object({
        settings: SettingsView.nullable(),
        /**
         * Every newsletter platform Direx can send through, connected or not. credentialId is the key
         * when one is connected; hasLists means its account can hold several lists, and listId and
         * listName are the one chosen, or null before a choice.
         */
        platforms: z.array(z.object({ connection: z.string(), name: z.string(), credentialId: z.uuid().nullable(), hasLists: z.boolean(), listId: z.string().nullable(), listName: z.string().nullable() })),
        /** The Workspace's connected lists a person can choose; Substack needs none. */
        lists: z.array(z.object({ credentialId: z.uuid(), connection: z.string(), name: z.string() })),
        /** When the next issue goes out, or null while it is off or not set up. */
        nextSlot: z.iso.datetime().nullable(),
        /** More than 31 days since the last issue, so the next one warns. */
        quiet: z.boolean(),
        /** How many people are on the list the issue goes to, read from the tool; null for Substack, before a list is chosen, or when the tool can't be read. */
        subscriberCount: z.number().int().nullable(),
      }),
      "The weekly newsletter's list and slot, or null settings before it is set up",
    ),
    ...errors,
  },
});
const putRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/newsletter/settings",
  middleware: [requirePermission("workspace.settings")],
  request: { params: ws, ...body(Settings) },
  responses: { 200: json(z.object({ settings: SettingsView }), "Saved"), ...errors },
});

const oneKey = ws.extend({ credentialId: z.uuid() });
const AccountList = z.object({ id: z.string(), name: z.string(), subscriberCount: z.number() }).openapi("NewsletterAccountList");
const listsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/newsletter/keys/{credentialId}/lists",
  middleware: [requirePermission("workspace.settings")],
  request: { params: oneKey },
  responses: { 200: json(z.object({ lists: z.array(AccountList) }), "The lists in the account behind a newsletter key, for choosing one"), ...errors },
});
const chooseListRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/newsletter/keys/{credentialId}/list",
  middleware: [requirePermission("workspace.settings")],
  request: { params: oneKey, ...body(z.strictObject({ listId: z.string().min(1).max(100) })) },
  responses: { 200: json(z.object({ list: AccountList }), "Chosen; the next issue goes to this list"), ...errors },
});
const listRefusal = (reason: string) => (reason === "list_not_connected" ? 404 : 409);

const IssueStats = z.object({ recipients: z.number(), delivered: z.number().optional(), clicks: z.number(), unsubscribes: z.number(), opens: z.number() });
const oneIssue = ws.extend({ itemId: z.uuid() });
const Issue = z
  .object({
    itemId: z.uuid(),
    state: z.string(),
    /** When approving stops working: the slot, or earlier for a tool that is handed issues ahead. Null for a late handoff. */
    approveBy: z.iso.datetime().nullable(),
    warnings: z.array(z.object({ code: z.string(), text: z.string() })),
    /** The Item's revision, which approving names. */
    revision: z.number(),
    slot: z.iso.datetime(),
    title: z.string(),
    previewText: z.string(),
    markdown: z.string(),
    /** What the list receives, rendered from the Markdown. */
    html: z.string(),
    /** The tool to copy a handoff into and send by hand; null for an issue Direx publishes. */
    handoffTo: z.string().nullable(),
    sentAt: z.iso.datetime().nullable(),
    /**
     * What the tool reported, read 30 minutes, 1 hour, 1 day and 7 days after the send. Opens are
     * unreliable: mail apps open many emails automatically, so show them labelled as such.
     */
    stats: IssueStats.nullable(),
    statsReadAt: z.iso.datetime().nullable(),
  })
  .openapi("NewsletterIssue");
const IssueInput = z
  .strictObject({
    title: z.string().trim().min(1).max(998).refine((s) => !/[\r\n]/.test(s), "one line"),
    previewText: z.string().trim().max(500).refine((s) => !/[\r\n]/.test(s), "one line").optional(),
    markdown: z.string().min(1).max(200_000),
  })
  .openapi("NewsletterIssueInput");
const listIssuesRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/newsletter/issues",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, query: z.object({ before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }) },
  responses: {
    200: json(
      z.object({
        issues: z.array(
          z
            .object({ itemId: z.uuid(), slot: z.iso.datetime(), title: z.string(), state: z.string(), reason: z.string().nullable(), sentAt: z.iso.datetime().nullable(), stats: IssueStats.nullable() })
            .openapi("NewsletterIssueSummary"),
        ),
        /** Pass as `before` for the next page; null on the last one. */
        next: z.iso.datetime().nullable(),
      }),
      "The weekly issues, newest slot first",
    ),
    ...errors,
  },
});
const issueOut = (v: IssueView) => ({ itemId: v.item.id, state: v.item.state, approveBy: v.item.at?.toISOString() ?? null, warnings: v.item.warnings, revision: v.item.revision, slot: v.slot, title: v.title, previewText: v.previewText, markdown: v.markdown, html: v.html, handoffTo: v.handoffTo, sentAt: v.sentAt, stats: v.stats, statsReadAt: v.statsReadAt });
const issueRefusal = (reason: string) => (reason === "not_found" ? 404 : 409);

const issueRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/newsletter/issues/{itemId}",
  middleware: [requirePermission("workspace.read")],
  request: { params: oneIssue },
  responses: { 200: json(Issue, "One weekly issue, as written and as it will be sent"), ...errors },
});
const reviseRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/newsletter/issues/{itemId}",
  middleware: [requirePermission("item.edit")],
  request: { params: oneIssue, ...body(IssueInput) },
  responses: { 200: json(Issue, "Saved; any approval it had is void"), ...errors },
});
const submitRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/newsletter/issues/{itemId}/submit",
  middleware: [requirePermission("item.edit")],
  request: { params: oneIssue },
  responses: { 200: json(Issue, "Waiting for approval"), ...errors },
});

const previewRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/newsletter/preview",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, ...body(z.strictObject({ markdown: z.string().max(200_000) })) },
  responses: { 200: json(z.object({ html: z.string() }), "The HTML this Markdown becomes, exactly as an issue would carry it"), ...errors },
});
const sentRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/newsletter/issues/{itemId}/sent",
  middleware: [requirePermission("item.edit")],
  request: { params: oneIssue },
  responses: { 200: json(Issue, "Recorded as sent by hand"), ...errors },
});

export function newsletterRoutes(deps: { newsletter: () => Newsletter; issues: () => IssueDesk }) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    },
  });
  app.openapi(getRoute, async (c) => c.json(await deps.newsletter().page(c.req.valid("param").workspaceId), 200));
  app.openapi(putRoute, async (c) => {
    const r = await deps.newsletter().saveSettings(c.req.valid("param").workspaceId, c.req.valid("json"));
    return r.ok ? c.json({ settings: r.settings }, 200) : c.json({ error: r.reason }, 409);
  });
  app.openapi(listsRoute, async (c) => {
    const { workspaceId, credentialId } = c.req.valid("param");
    const r = await deps.newsletter().lists(workspaceId, credentialId);
    return r.ok ? c.json({ lists: [...r.lists] }, 200) : c.json({ error: r.reason }, listRefusal(r.reason));
  });
  app.openapi(chooseListRoute, async (c) => {
    const { workspaceId, credentialId } = c.req.valid("param");
    const r = await deps.newsletter().chooseList(workspaceId, credentialId, c.req.valid("json").listId);
    return r.ok ? c.json({ list: r.list }, 200) : c.json({ error: r.reason }, listRefusal(r.reason));
  });
  app.openapi(listIssuesRoute, async (c) => {
    const { before, limit } = c.req.valid("query");
    return c.json(await deps.issues().list(c.req.valid("param").workspaceId, before ? new Date(before) : null, limit), 200);
  });
  app.openapi(issueRoute, async (c) => {
    const { workspaceId, itemId } = c.req.valid("param");
    const v = await deps.issues().get(workspaceId, itemId);
    return v ? c.json(issueOut(v), 200) : c.json({ error: "not_found" }, 404);
  });
  app.openapi(reviseRoute, async (c) => {
    const { workspaceId, itemId } = c.req.valid("param");
    const r = await deps.issues().revise(workspaceId, itemId, c.req.valid("json"), c.get("member").userId);
    return r.ok ? c.json(issueOut(r.issue), 200) : c.json({ error: r.reason }, issueRefusal(r.reason));
  });
  app.openapi(submitRoute, async (c) => {
    const { workspaceId, itemId } = c.req.valid("param");
    const r = await deps.issues().submit(workspaceId, itemId, c.get("member").userId);
    return r.ok ? c.json(issueOut(r.issue), 200) : c.json({ error: r.reason }, issueRefusal(r.reason));
  });
  app.openapi(previewRoute, async (c) => c.json({ html: renderIssue(c.req.valid("json").markdown) }, 200));
  app.openapi(sentRoute, async (c) => {
    const { workspaceId, itemId } = c.req.valid("param");
    const r = await deps.issues().markSent(workspaceId, itemId, c.get("member").userId);
    return r.ok ? c.json(issueOut(r.issue), 200) : c.json({ error: r.reason }, issueRefusal(r.reason));
  });
  return app;
}
