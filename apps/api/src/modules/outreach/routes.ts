// SPDX-License-Identifier: AGPL-3.0-only
// Outreach over HTTP. identity's Workspace middleware has resolved the caller, and approving uses
// the items routes. The unsubscribe link takes no sign-in: its token is the only proof.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { can, requirePermission, requireStepUp, type MemberEnv } from "../identity/index";
import type { Outreach } from "./application/outreach";
import { mailboxChecks } from "./application/header-check";
import { HOOK_MAX_BYTES, type HoldHooks } from "./application/hold-hooks";
import type { Holds } from "./application/holds";
import { createMailboxDomains, type MailboxDomains } from "./application/domain-report";
import type { MailboxPauses } from "./application/mailboxes";
import { CHANNELS, type OutsideTouches } from "./application/outside-touches";
import { authenticated } from "./domain/domain-report";
import { BASES, CONFIDENCES, ENTITY_TYPES, WARNINGS } from "./domain/eligibility";

const ErrorBody = z.object({ error: z.string() }).openapi("OutreachError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const errors = { 400: json(ErrorBody, "Invalid request"), 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not allowed"), 404: json(ErrorBody, "Not found"), 409: json(ErrorBody, "Refused, with a named reason") };
const ws = z.object({ workspaceId: z.uuid() });
const Ok = z.object({ ok: z.literal(true) });

const country = z.string().regex(/^[A-Z]{2}$/);
/** What holds a Person's cold email: the reason code, its detail, which guess Release lets go, and when the wait after an ended hold ends. */
const HoldView = z
  .object({
    reason: z.string(),
    detail: z.string().nullable(),
    release: z.enum(["inferred", "company"]).nullable(),
    waitUntil: z.iso.datetime().nullable().openapi({ description: "Set once every certain hold has ended: cold email waits until then, and nothing is left to stop" }),
  })
  .openapi("HoldView");
const Record = z
  .object({
    country: z.string().nullable(),
    basis: z.string().nullable(),
    entityType: z.string().nullable(),
    scope: z.string().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    confidence: z.string().nullable(),
    // Suggestions from country research, never a hold.
    warnings: z.array(z.enum(WARNINGS)),
  })
  .openapi("EligibilityRecord");
const Overview = z
  .object({
    senderName: z.string().nullable(),
    postalAddress: z.string().nullable(),
    senderCountry: z.string().nullable(),
    paused: z.boolean(),
    people: z.array(
      Record.extend({
        id: z.uuid(),
        email: z.string(),
        suppressed: z.boolean(),
        suppressedBecause: z.string().nullable(),
        quote: z.string().nullable(),
        /** When this Person was first seen on a newsletter list, which keeps them out of cold email. */
        newsletterSince: z.string().nullable(),
        hold: HoldView.nullable(),
        /** The first name and company from the latest Campaign they are in. */
        name: z.string().nullable(),
        company: z.string().nullable(),
        campaign: z.object({ id: z.uuid(), title: z.string() }).nullable(),
        lastEmailAt: z.iso.datetime().nullable(),
        replied: z.boolean(),
      }),
    ),
  })
  .openapi("Outreach");

const replyRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/outreach/replies/{signalId}",
  middleware: [requirePermission("item.approve")],
  request: { params: ws.extend({ signalId: z.uuid() }) },
  responses: { 200: json(z.object({ senderEmail: z.string(), text: z.string().nullable(), status: z.string() }), "One reply to judge"), ...errors },
});
const replyCountRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/outreach/reply-count",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, query: z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }) },
  responses: { 200: json(z.object({ replies: z.number().int(), optedOut: z.number().int() }), "Replies received between two times, and how many asked to stop"), ...errors },
});
const ResultLine = z.object({ key: z.string(), label: z.string(), now: z.number().int(), before: z.number().int(), why: z.string().nullable() }).openapi("OutreachResultLine");
const resultsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/outreach/results",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ results: z.array(ResultLine) }), "Replies and opt-outs over the last 7 days against the 7 before, each with the sentence behind it when one holds"), ...errors },
});
const overviewRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/outreach", middleware: [requirePermission("workspace.read")], request: { params: ws }, responses: { 200: json(Overview, "Sender, pause and People"), ...errors } });
const MailboxCheck = z
  .object({
    credentialId: z.uuid(),
    state: z.enum(["unchecked", "pending", "passed", "replies_only", "failed", "inconclusive"]),
    reason: z.string().nullable(),
    failures: z.array(z.string()),
    warnings: z.array(z.string()),
    checkedAt: z.iso.datetime(),
  })
  .openapi("MailboxCheck");
const mailboxChecksRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/outreach/mailbox-checks",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ checks: z.array(MailboxCheck) }), "Each Mailbox's current header check; a Mailbox not listed was never checked"), ...errors },
});
const identityRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/outreach/identity",
  middleware: [requirePermission("workspace.settings")],
  request: { params: ws, ...body(z.strictObject({ senderName: z.string().trim().min(1).max(200), postalAddress: z.string().trim().min(1).max(500), senderCountry: country.nullable().optional() })) },
  responses: { 200: json(Ok, "Saved"), ...errors },
});
const pauseRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/outreach/pause",
  middleware: [requirePermission("item.approve")],
  request: { params: ws, ...body(z.strictObject({ paused: z.boolean() })) },
  responses: { 200: json(Ok, "Saved"), ...errors },
});
const personRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/outreach/people",
  middleware: [requirePermission("item.edit")],
  request: {
    params: ws,
    ...body(
      z.strictObject({
        email: z.string().max(320),
        country,
        basis: z.enum(BASES),
        evidence: z.string().trim().min(1).max(1000),
        entityType: z.enum(ENTITY_TYPES).optional(),
        scope: z.string().trim().max(500).nullable().optional(),
        expiresAt: z.iso.date().nullable().optional(),
        confidence: z.enum(CONFIDENCES).optional(),
      }),
    ),
  },
  responses: { 200: json(z.object({ id: z.uuid(), updated: z.boolean().openapi({ description: "The email was already a Person here, so its record was replaced" }) }), "Added, or found by email, with this record saved"), ...errors },
});
const personRecordRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/outreach/people/{personId}",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws.extend({ personId: z.uuid() }) },
  responses: { 200: json(Record, "Why this Person may be contacted"), ...errors },
});
const OutsideTouch = z
  .object({ id: z.uuid(), channel: z.string(), direction: z.string(), occurredAt: z.iso.datetime(), source: z.string(), canDelete: z.boolean() })
  .openapi("OutsideTouch");
const personParams = ws.extend({ personId: z.uuid() });
const logTouchRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/outreach/people/{personId}/outside-touches",
  middleware: [requirePermission("item.edit")],
  request: {
    params: personParams,
    ...body(z.strictObject({ channel: z.enum(CHANNELS), direction: z.enum(["outbound", "inbound"]), occurredAt: z.iso.datetime({ offset: true }) })),
  },
  responses: { 201: json(OutsideTouch, "Logged"), ...errors },
});
const listTouchesRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/outreach/people/{personId}/outside-touches",
  middleware: [requirePermission("workspace.read")],
  request: { params: personParams },
  responses: {
    200: json(
      z.object({
        touches: z.array(OutsideTouch),
        profiles: z.array(z.object({ kind: z.enum(["linkedin", "x"]), url: z.string() })).openapi({ description: "The LinkedIn and X profiles saved on the Person, oldest first" }),
      }),
      "The last 90 days, newest first, and the Person's saved profiles",
    ),
    ...errors,
  },
});
const deleteTouchRoute = createRoute({
  method: "delete",
  path: "/api/w/{workspaceId}/outreach/people/{personId}/outside-touches/{id}",
  middleware: [requirePermission("item.edit")],
  request: { params: personParams.extend({ id: z.uuid() }) },
  responses: { 204: { description: "Removed" }, ...errors },
});
const profileRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/outreach/people/{personId}/profiles",
  middleware: [requirePermission("item.edit")],
  request: { params: personParams, ...body(z.strictObject({ kind: z.enum(["linkedin", "x"]), url: z.string().trim().min(1).max(300) })) },
  responses: { 200: json(z.object({ url: z.string() }), "Saved, as the profile address a DM opens"), ...errors },
});
const suppressRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/outreach/suppressions",
  middleware: [requirePermission("item.edit")],
  request: { params: ws, ...body(z.strictObject({ email: z.string().max(320) })) },
  responses: { 200: json(Ok, "Recorded; it can't be undone here"), ...errors },
});
const undoOptOutRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/outreach/people/{personId}/undo-opt-out",
  middleware: [requirePermission("outreach.undo_optout"), requireStepUp("long")],
  request: { params: personParams, ...body(z.strictObject({ reason: z.string().trim().min(1).max(1000) })) },
  responses: { 200: json(z.object({ ok: z.literal(true), undone: z.number().int() }), "Undone and recorded; a Blocked send stays Blocked"), ...errors },
});
const emailRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/outreach/emails",
  middleware: [requirePermission("item.edit")],
  request: {
    params: ws,
    ...body(
      z.strictObject({
        personId: z.uuid(),
        credentialId: z.uuid(),
        touchClass: z.enum(["cold", "consented_marketing"]),
        subject: z.string().trim().min(1).max(998).refine((s) => !/[\r\n]/.test(s), "one line"),
        text: z.string().trim().min(1).max(100_000),
        plannedAt: z.iso.datetime().optional(),
      }),
    ),
  },
  responses: { 200: json(z.object({ itemId: z.uuid() }), "A draft waiting for approval"), ...errors },
});

const holdPerson = ws.extend({ personId: z.uuid() });
const personHoldsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/outreach/people/{personId}/holds",
  middleware: [requirePermission("workspace.read")],
  request: { params: holdPerson },
  responses: {
    200: json(z.object({ hold: HoldView.nullable(), holds: z.array(z.object({ id: z.uuid(), source: z.string(), reason: z.string(), expiresAt: z.iso.datetime() })) }).openapi("PersonHolds"), "What holds this Person"),
    ...errors,
  },
});
const addHoldRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/outreach/people/{personId}/holds",
  middleware: [requirePermission("item.approve")],
  request: { params: holdPerson, ...body(z.strictObject({ reason: z.string().trim().min(1).max(200), days: z.number().int().min(1).max(365).optional() })) },
  responses: { 200: json(Ok, "Held, and their campaigns stopped"), ...errors },
});
const releaseRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/outreach/people/{personId}/holds/release",
  middleware: [requirePermission("item.approve")],
  request: { params: holdPerson, ...body(z.strictObject({ kind: z.enum(["inferred", "company"]) })) },
  responses: { 200: json(z.object({ ok: z.literal(true), resumed: z.number() }), "Released; held emails are checked again"), ...errors },
});
const endHoldRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/outreach/holds/{holdId}/end",
  middleware: [requirePermission("workspace.settings")],
  request: { params: ws.extend({ holdId: z.uuid() }) },
  responses: { 200: json(Ok, "Ended; the 90-day wait still follows"), ...errors },
});

const HookMade = z.object({ id: z.uuid(), path: z.string(), secret: z.string() }).openapi("HoldHookSecret");
const hookStatusRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/outreach/hold-hook",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ hook: z.object({ id: z.uuid(), path: z.string(), createdAt: z.iso.datetime() }).nullable() }).openapi("HoldHook"), "The Workspace's hold webhook, without its secret"), ...errors },
});
const hookCreateRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/outreach/hold-hook",
  middleware: [requirePermission("workspace.settings"), requireStepUp("short")],
  request: { params: ws },
  responses: { 200: json(HookMade, "Made; the secret is shown this once"), ...errors },
});
const hookRotateRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/outreach/hold-hook/{hookId}/rotate",
  middleware: [requirePermission("workspace.settings"), requireStepUp("short")],
  request: { params: ws.extend({ hookId: z.uuid() }) },
  responses: { 200: json(HookMade, "A new secret, shown this once; the old one stops working"), ...errors },
});
const MailboxPause = z.object({ credentialId: z.uuid(), pausedAt: z.iso.datetime(), reason: z.enum(["bounces", "provider_abuse", "person"]) }).openapi("MailboxPause");
const DomainReport = z
  .object({
    domain: z.string(),
    consumer: z.boolean(),
    mx: z.enum(["pass", "missing", "unknown"]),
    spf: z.enum(["pass", "missing", "no_provider_include", "unknown"]),
    dkim: z.enum(["pass", "not_found", "unknown"]),
    dmarc: z.enum(["none", "quarantine", "reject", "missing", "unknown"]),
    authenticated: z.boolean(),
  })
  .openapi("MailboxDomainReport");
const domainRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/outreach/mailboxes/{credentialId}/domain",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws.extend({ credentialId: z.uuid() }) },
  responses: { 200: json(DomainReport, "What DNS says about the domain the Mailbox sends from, read now"), ...errors },
});
const pausesRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/outreach/mailbox-pauses",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ pauses: z.array(MailboxPause) }), "Each paused Mailbox; a Mailbox not listed is sending"), ...errors },
});
const mailboxPauseRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/outreach/mailboxes/{credentialId}/pause",
  middleware: [requirePermission("item.edit")],
  request: { params: ws.extend({ credentialId: z.uuid() }), ...body(z.strictObject({ paused: z.boolean() })) },
  responses: { 200: json(Ok, "Saved"), ...errors },
});

const hookPath = (workspaceId: string, id: string) => `/api/hooks/holds/${workspaceId}/${id}`;
const validHook = z.object({ workspaceId: z.uuid(), hookId: z.uuid() });

const validLink = z.object({ workspaceId: z.uuid(), token: z.string().regex(/^[0-9a-f]{64}$/) });
const PAGE = `<!doctype html><meta charset="utf-8"><title>Unsubscribe</title><form method="post"><p>Stop these emails?</p><button>Unsubscribe</button></form>`;

const nodeDomains = createMailboxDomains();

export function outreachRoutes(deps: { outreach: () => Outreach; outsideTouches?: () => OutsideTouches; holds?: () => Holds; holdHooks?: () => HoldHooks; pauses?: () => MailboxPauses; domains?: () => MailboxDomains }) {
  const app = new OpenAPIHono<MemberEnv>();

  // DNS through Node unless a test gives its own.
  const domains = deps.domains ?? (() => nodeDomains);
  app.openapi(domainRoute, async (c) => {
    const { workspaceId, credentialId } = c.req.valid("param");
    const r = await domains().report(workspaceId, credentialId);
    return r ? c.json({ ...r, authenticated: authenticated(r) }, 200) : c.json({ error: "not_found" }, 404);
  });

  const pauses = deps.pauses;
  if (pauses) {
    app.openapi(pausesRoute, async (c) => {
      const list = await pauses().paused(c.req.valid("param").workspaceId);
      return c.json({ pauses: list.map((p) => ({ ...p, pausedAt: p.pausedAt.toISOString() })) }, 200);
    });
    app.openapi(mailboxPauseRoute, async (c) => {
      const { workspaceId, credentialId } = c.req.valid("param");
      const m = c.get("member");
      const r = await pauses().set(workspaceId, credentialId, c.req.valid("json").paused, { userId: m.userId, mayResume: can(m.role, "item.approve") });
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, r.reason === "forbidden" ? 403 : 404);
    });
  }

  const hooks = deps.holdHooks;
  if (hooks) {
    app.openapi(hookStatusRoute, async (c) => {
      const { workspaceId } = c.req.valid("param");
      const { hook } = await hooks().status(workspaceId);
      return c.json({ hook: hook && { ...hook, path: hookPath(workspaceId, hook.id) } }, 200);
    });
    app.openapi(hookCreateRoute, async (c) => {
      const { workspaceId } = c.req.valid("param");
      const r = await hooks().create(workspaceId, c.get("member").userId);
      return r.ok ? c.json({ id: r.id, path: hookPath(workspaceId, r.id), secret: r.secret }, 200) : c.json({ error: r.reason }, 409);
    });
    app.openapi(hookRotateRoute, async (c) => {
      const { workspaceId, hookId } = c.req.valid("param");
      const r = await hooks().rotate(workspaceId, hookId, c.get("member").userId);
      if (r.ok) return c.json({ id: r.id, path: hookPath(workspaceId, r.id), secret: r.secret }, 200);
      return c.json({ error: r.reason }, r.reason === "stale_version" ? 409 : 404);
    });
    // No sign-in: the signature over the body is the only proof, and it opens only its own Workspace.
    app.post("/api/hooks/holds/:workspaceId/:hookId", bodyLimit({ maxSize: HOOK_MAX_BYTES, onError: (c) => c.json({ error: "too_large" }, 413) }), async (c) => {
      const p = validHook.safeParse(c.req.param());
      if (!p.success) return c.json({ error: "bad_signature" }, 401);
      const r = await hooks().receive(p.data.workspaceId, p.data.hookId, new Uint8Array(await c.req.arrayBuffer()), c.req.header("x-signature"));
      if (r.ok) return c.json({ ok: true, held: r.held }, 200);
      return c.json({ error: r.reason }, r.reason === "bad_signature" ? 401 : r.reason === "too_large" ? 413 : 400);
    });
  }

  const holds = deps.holds;
  if (holds) {
    app.openapi(personHoldsRoute, async (c) => {
      const { workspaceId, personId } = c.req.valid("param");
      return c.json(await holds().ofPerson(workspaceId, personId), 200);
    });
    app.openapi(addHoldRoute, async (c) => {
      const { workspaceId, personId } = c.req.valid("param");
      const r = await holds().addManual(workspaceId, personId, { ...c.req.valid("json"), userId: c.get("member").userId });
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 404);
    });
    app.openapi(releaseRoute, async (c) => {
      const { workspaceId, personId } = c.req.valid("param");
      const r = await holds().release(workspaceId, personId, c.req.valid("json").kind, c.get("member").userId);
      return r.ok ? c.json(r, 200) : c.json({ error: r.reason }, 404);
    });
    app.openapi(endHoldRoute, async (c) => {
      const { workspaceId, holdId } = c.req.valid("param");
      const r = await holds().end(workspaceId, holdId, c.get("member").userId);
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 404);
    });
  }

  const touches = deps.outsideTouches;
  if (touches) {
    app.openapi(logTouchRoute, async (c) => {
      const { workspaceId, personId } = c.req.valid("param");
      const b = c.req.valid("json");
      const r = await touches().log(workspaceId, personId, { ...b, occurredAt: new Date(b.occurredAt) }, c.get("member").userId);
      if (r.ok) return c.json(r.touch, 201);
      return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 400);
    });
    app.openapi(listTouchesRoute, async (c) => {
      const { workspaceId, personId } = c.req.valid("param");
      const [list, profiles] = await Promise.all([touches().list(workspaceId, personId), touches().profiles(workspaceId, personId)]);
      return c.json({ touches: list, profiles }, 200);
    });
    app.openapi(profileRoute, async (c) => {
      const { workspaceId, personId } = c.req.valid("param");
      const b = c.req.valid("json");
      const r = await touches().addProfile(workspaceId, personId, b.kind, b.url);
      if (r.ok) return c.json({ url: r.url }, 200);
      return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 400);
    });
    app.openapi(deleteTouchRoute, async (c) => {
      const { workspaceId, personId, id } = c.req.valid("param");
      const r = await touches().remove(workspaceId, personId, id);
      if (r.ok) return c.body(null, 204);
      return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
    });
  }

  app.openapi(overviewRoute, async (c) => c.json(await deps.outreach().overview(c.req.valid("param").workspaceId), 200));
  app.openapi(mailboxChecksRoute, async (c) => c.json({ checks: (await mailboxChecks(c.req.valid("param").workspaceId)) as z.infer<typeof MailboxCheck>[] }, 200));
  app.openapi(identityRoute, async (c) => {
    await deps.outreach().saveIdentity(c.req.valid("param").workspaceId, c.req.valid("json"));
    return c.json({ ok: true as const }, 200);
  });
  app.openapi(pauseRoute, async (c) => {
    await deps.outreach().setPaused(c.req.valid("param").workspaceId, c.req.valid("json").paused, c.get("member").userId);
    return c.json({ ok: true as const }, 200);
  });
  app.openapi(personRoute, async (c) => {
    const { expiresAt, ...b } = c.req.valid("json");
    const r = await deps.outreach().addPerson(c.req.valid("param").workspaceId, { ...b, expiresAt: expiresAt ? new Date(`${expiresAt}T00:00:00Z`) : null, userId: c.get("member").userId });
    return r.ok ? c.json({ id: r.id, updated: r.existed }, 200) : c.json({ error: r.reason }, 400);
  });
  app.openapi(personRecordRoute, async (c) => {
    const { workspaceId, personId } = c.req.valid("param");
    const record = await deps.outreach().person(workspaceId, personId);
    return record ? c.json(record, 200) : c.json({ error: "not_found" }, 404);
  });
  app.openapi(replyCountRoute, async (c) => {
    const q = c.req.valid("query");
    return c.json(await deps.outreach().replyCount(c.req.valid("param").workspaceId, new Date(q.from), new Date(q.to)), 200);
  });
  app.openapi(resultsRoute, async (c) => c.json({ results: await deps.outreach().results(c.req.valid("param").workspaceId, c.get("member").userId) }, 200));
  app.openapi(replyRoute, async (c) => {
    const { workspaceId, signalId } = c.req.valid("param");
    const reply = await deps.outreach().reply(workspaceId, signalId);
    return reply ? c.json(reply, 200) : c.json({ error: "not_found" }, 404);
  });
  app.openapi(suppressRoute, async (c) => {
    const ok = await deps.outreach().addSuppression(c.req.valid("param").workspaceId, c.req.valid("json").email);
    return ok ? c.json({ ok: true as const }, 200) : c.json({ error: "bad_email" }, 400);
  });
  app.openapi(undoOptOutRoute, async (c) => {
    const { workspaceId, personId } = c.req.valid("param");
    const r = await deps.outreach().undoReplyOptOut(workspaceId, personId, c.req.valid("json").reason, c.get("member").userId);
    return r.ok ? c.json(r, 200) : c.json({ error: r.reason }, 409);
  });
  app.openapi(emailRoute, async (c) => {
    const b = c.req.valid("json");
    const r = await deps.outreach().compose(c.req.valid("param").workspaceId, { ...b, plannedAt: b.plannedAt ? new Date(b.plannedAt) : undefined }, c.get("member").userId);
    if (r.ok) return c.json({ itemId: r.item.id }, 200);
    return c.json({ error: r.reason }, r.reason === "sender_identity_missing" || r.reason === "mailbox_replies_only" ? 409 : 404);
  });

  // A mail scanner may follow a GET, so only the POST unsubscribes (RFC 8058).
  app.get("/api/unsubscribe/:workspaceId/:token", async (c) => {
    const p = validLink.safeParse(c.req.param());
    if (!p.success || !(await deps.outreach().tokenIsValid(p.data.workspaceId, p.data.token))) return c.text("Not found", 404);
    return c.html(PAGE);
  });
  app.post("/api/unsubscribe/:workspaceId/:token", async (c) => {
    const p = validLink.safeParse(c.req.param());
    if (!p.success || !(await deps.outreach().unsubscribe(p.data.workspaceId, p.data.token))) return c.text("Not found", 404);
    return c.text("You won't get these emails again.");
  });
  return app;
}
