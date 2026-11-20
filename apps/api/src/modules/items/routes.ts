// SPDX-License-Identifier: AGPL-3.0-only
// Items over HTTP. identity's Workspace middleware has already resolved the caller. Bodies
// are strict, so a snapshot or approver in a request is refused, not ignored.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { approverFromMember, can, requirePermission, steppedUp, type Member, type MemberEnv, type Permission } from "../identity/index";
import type { Decided } from "./application/decide";
import type { Items } from "./application/create";
import { orderOf, parseListCursor } from "./domain/list-cursor";
import { MAX_REASON_NOTE, REVIEW_REASONS } from "./domain/rates";
import { WARNING_CODES } from "./domain/warnings";

/** One warning as every route returns it. */
export const WarningShape = z.object({ code: z.enum(WARNING_CODES), text: z.string() }).openapi("Warning");

const MAX_BULK = 200;
const MAX_PAGE = 500;

const ErrorBody = z.object({ error: z.string(), cap: z.string().optional(), day: z.string().optional(), limit: z.number().optional() }).openapi("ItemError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not allowed"),
  404: json(ErrorBody, "Not found"),
  409: json(ErrorBody, "Refused, with a named reason"),
};
const ws = z.object({ workspaceId: z.uuid() });
const one = ws.extend({ id: z.uuid() });
const State = z.enum(["draft", "needs_approval", "scheduled", "sent", "applied", "held", "blocked", "cancelled"]);
const Item = z
  .object({
    id: z.uuid(),
    kind: z.string(),
    state: State,
    reason: z.string().nullable(),
    reasonCode: z.string().nullable(),
    revision: z.number(),
    title: z.string(),
    workArea: z.string().nullable(),
    channel: z.string().nullable(),
    groupKey: z.string().nullable(),
    groupLabel: z.string().nullable(),
    at: z.iso.datetime().nullable(),
    warnings: z.array(WarningShape),
    clean: z.boolean(),
    movable: z.boolean(),
    decideBy: z.iso.datetime().nullable(),
    snoozedUntil: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Item");
const TimelineEntry = z
  .object({
    at: z.iso.datetime(),
    from: State.nullable(),
    to: State,
    reason: z.string().nullable(),
    actor: z.object({ kind: z.enum(["person", "agent", "system"]), id: z.string() }),
    /** Milliseconds between the last check and the provider call, on the entry that settled a send. */
    dispatchGapMs: z.number().int().nullable().optional(),
  })
  .openapi("ItemTimelineEntry");
const ItemResult = z.object({ id: z.uuid(), ok: z.boolean(), reason: z.string().optional(), cap: z.string().optional(), day: z.string().optional(), limit: z.number().optional() }).openapi("ItemResult");
const Results = z.object({ results: z.array(ItemResult) });
const One = z.object({ item: Item });

/** A bounded comma list of values matching `one`, such as "sent,held". */
const commaList = (one: string, max = 20) => z.string().regex(new RegExp(`^(${one})(,(${one})){0,${max - 1}}$`));
const split = <T extends string>(s: string | undefined) => (s ? (s.split(",") as T[]) : undefined);

const listRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/items",
  middleware: [requirePermission("workspace.read")],
  request: {
    params: ws,
    query: z.object({
      needsYou: z.enum(["true", "false"]).optional(),
      state: commaList(State.options.join("|")).optional().openapi({ description: "One state or several, comma separated" }),
      channel: commaList("[a-z_]{1,32}").optional(),
      type: commaList("[a-z_]{1,32}", 32).optional().openapi({ description: "Work areas of Actions and kinds of other Items, comma separated, at most 32" }),
      campaign: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
      q: z.string().trim().min(1).max(100).optional().openapi({ description: "Words in the title or group label" }),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      cursor: z.string().max(300).optional(),
      limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(100),
    }),
  },
  responses: {
    200: json(z.object({ items: z.array(Item), needsYouCount: z.number(), nextCursor: z.string().nullable() }), "Matching Items"),
    ...errors,
  },
});
const Recipient = z
  .object({
    signals: z.array(z.object({ type: z.string(), quote: z.string(), pageUrl: z.string(), observedOn: z.string() })),
    roleAddress: z.boolean(),
    guessedAddress: z.boolean(),
    spans: z.array(z.object({ text: z.string(), kind: z.enum(["same", "added"]) })).nullable().optional(),
  })
  .openapi("RecipientNotes");
const Appearance = z
  .discriminatedUnion("kind", [z.object({ kind: z.literal("email"), from: z.string() }), z.object({ kind: z.literal("post"), account: z.string().nullable(), network: z.string(), link: z.object({ url: z.string(), title: z.string().nullable(), description: z.string().nullable(), site: z.string(), image: z.boolean() }).nullable() })])
  .openapi("ItemAppearance");
/** What a draft was written from, as recorded: its Run, the plan that Run read, its Campaign step, the Facts it cites. */
const WrittenFrom = z
  .object({
    run: z.object({ id: z.uuid(), agent: z.string(), at: z.iso.datetime() }).nullable(),
    planId: z.string().nullable(),
    step: z.object({ campaignId: z.string(), stepKey: z.string() }).nullable(),
    facts: z.array(z.object({ id: z.uuid(), version: z.number().int(), text: z.string() })),
    lessons: z.array(z.object({ id: z.uuid(), text: z.string() })),
    voice: z.boolean(),
  })
  .openapi("ItemWrittenFrom");
const getRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/items/{id}",
  middleware: [requirePermission("workspace.read")],
  request: { params: one },
  responses: { 200: json(z.object({ item: Item, content: z.unknown(), timeline: z.array(TimelineEntry), ruleGrantedBy: z.string().nullable(), ruleWrittenBy: z.string().nullable().optional(), recipient: Recipient.nullable().optional(), appearance: Appearance.nullable().optional(), writtenFrom: WrittenFrom.nullable().optional(), undo: z.object({ ok: z.boolean(), reason: z.string().optional() }).nullable().optional() }), "One Item"), ...errors },
});
const ratesRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/review-rates",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: {
    200: json(z.object({ decisions: z.number(), medianSeconds: z.number().nullable(), changedShare: z.number().nullable(), warning: z.boolean() }).openapi("ReviewRates"), "The signed-in person's own review rates"),
    ...errors,
  },
});
const approveRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/items/{id}/approve",
  // `openedAt` is when the review page opened the Item; sent, the decision counts toward the person's own review rates.
  // `praise` is "This one's great", kept with the decision.
  // Three 400-character edits can each use six JSON characters per code unit, plus 75 for the envelope.
  request: { params: one, ...body(z.strictObject({ revision: z.number().int().positive(), choice: z.string().max(7275).optional(), openedAt: z.iso.datetime().optional(), praise: z.boolean().optional() })) },
  responses: { 200: json(One, "Approved"), ...errors },
});
const approveCleanRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/items/approve-clean",
  middleware: [requirePermission("item.approve")],
  request: {
    params: ws,
    ...body(z.strictObject({ items: z.array(z.strictObject({ id: z.uuid(), revision: z.number().int().positive() })).min(1).max(MAX_BULK) })),
  },
  responses: { 200: json(Results, "One result per Item"), ...errors },
});
const cancelRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/items/{id}/cancel",
  middleware: [requirePermission("item.edit")],
  // `reason` and `note` say why a person dropped a draft; they are counted against its Campaign step.
  request: { params: one, query: z.object({ openedAt: z.iso.datetime().optional(), reason: z.enum(REVIEW_REASONS).optional(), note: z.string().max(MAX_REASON_NOTE).optional() }) },
  responses: { 200: json(One, "Cancelled"), ...errors },
});
const undoRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/items/{id}/undo",
  // The kind names the permission its undo takes; a viewer never gets that far.
  middleware: [requirePermission("item.edit")],
  request: { params: one },
  responses: { 200: json(One, "Undone; the Item stays Applied"), ...errors },
});
const resumeRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/items/{id}/resume",
  middleware: [requirePermission("item.approve")],
  request: { params: one },
  responses: { 200: json(One, "Resumed; every check runs again"), ...errors },
});
const resolveRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/items/{id}/resolve-unknown",
  middleware: [requirePermission("item.approve")],
  request: { params: one, ...body(z.strictObject({ choice: z.enum(["mark_sent", "resend"]) })) },
  responses: { 200: json(One, "Settled"), ...errors },
});
const moveRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/items/move",
  middleware: [requirePermission("item.edit")],
  request: {
    params: ws,
    ...body(z.strictObject({ items: z.array(z.strictObject({ id: z.uuid(), plannedAt: z.iso.datetime() })).min(1).max(MAX_BULK) })),
  },
  responses: { 200: json(Results, "One result per Item"), ...errors },
});
const triageRoute = createRoute({
  method: "patch",
  path: "/api/w/{workspaceId}/items/{id}/triage",
  middleware: [requirePermission("item.edit")],
  request: {
    params: one,
    ...body(z.strictObject({ decideBy: z.iso.datetime().nullable().optional(), snoozedUntil: z.iso.datetime().nullable().optional() })),
  },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "Saved"), ...errors },
});

const iso = (d: Date | null) => d && d.toISOString();
const dateOr = (s: string | null | undefined) => (s === undefined ? undefined : s === null ? null : new Date(s));
type View = NonNullable<Awaited<ReturnType<Items["view"]>>>;
const toJson = (i: View) => ({ ...i, at: iso(i.at), decideBy: iso(i.decideBy), snoozedUntil: iso(i.snoozedUntil), createdAt: i.createdAt.toISOString() });
const status = (reason: string) => (reason === "not_found" ? 404 : reason === "forbidden" || reason === "step_up_required" ? 403 : 409);
const detail = (r: Exclude<Decided, { ok: true }>) => ({ ...(r.cap && { cap: r.cap }), ...(r.day && { day: r.day }), ...(r.limit && { limit: r.limit }) });
const refused = (r: Exclude<Decided, { ok: true }>) => ({ error: r.reason, ...detail(r) });
const toResults = (rs: { id: string; result: Decided }[]) => ({
  results: rs.map(({ id, result: r }) => (r.ok ? { id, ok: true } : { id, ok: false, reason: r.reason, ...detail(r) })),
});
// Every Item kind with `stepUp` is an everyday approval (lessons, keys lost, late sends), so the long window (ADR 0037 rule 004).
const whoFrom = (m: Member) => ({ approverId: approverFromMember(m), may: (p: string) => can(m.role, p as Permission), steppedUp: steppedUp(m, "long") });

export function itemRoutes({ items }: { items: () => Items }) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
    },
  });
  const answer = (c: { json: (b: object, s: 200 | 403 | 404 | 409) => Response }, r: Decided) =>
    r.ok ? c.json({ item: toJson(r.item) }, 200) : c.json(refused(r), status(r.reason));

  return app
    .openapi(listRoute, async (c) => {
      const q = c.req.valid("query");
      const f = { needsYou: q.needsYou === "true", state: split<z.infer<typeof State>>(q.state), channels: split(q.channel), types: split(q.type), campaign: q.campaign, q: q.q, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined, limit: q.limit };
      const after = q.cursor ? parseListCursor(q.cursor, orderOf(f)) : undefined;
      if (after === null) return c.json({ error: "bad_cursor" }, 400);
      const r = await items().list(c.get("member").workspaceId, { ...f, after });
      return c.json({ items: r.items.map(toJson), needsYouCount: r.needsYouCount, nextCursor: r.nextCursor }, 200);
    })
    .openapi(getRoute, async (c) => {
      const d = await items().detail(c.get("member").workspaceId, c.req.valid("param").id);
      if (!d) return c.json({ error: "not_found" }, 404);
      return c.json({ item: toJson(d.item), content: d.content, timeline: d.timeline.map((e) => ({ ...e, at: e.at.toISOString() })), ruleGrantedBy: d.ruleGrantedBy, ruleWrittenBy: d.ruleWrittenBy, recipient: d.recipient, appearance: d.appearance, writtenFrom: d.writtenFrom && { ...d.writtenFrom, run: d.writtenFrom.run && { ...d.writtenFrom.run, at: d.writtenFrom.run.at.toISOString() } }, undo: d.undo }, 200);
    })
    .openapi(approveRoute, async (c) => {
      const m = c.get("member");
      const { revision, choice, openedAt, praise } = c.req.valid("json");
      return answer(c as never, await items().approve(m.workspaceId, c.req.valid("param").id, revision, whoFrom(m), choice, openedAt ? new Date(openedAt) : undefined, praise)) as never;
    })
    // Only ever the caller's own: nobody reads another person's rates.
    .openapi(ratesRoute, async (c) => {
      const m = c.get("member");
      return c.json(await items().reviewRates(m.workspaceId, m.userId), 200);
    })
    .openapi(approveCleanRoute, async (c) => {
      const m = c.get("member");
      return c.json(toResults(await items().approveClean(m.workspaceId, c.req.valid("json").items, whoFrom(m))), 200);
    })
    .openapi(cancelRoute, async (c) => {
      const m = c.get("member");
      const { openedAt, reason, note } = c.req.valid("query");
      return answer(c as never, await items().cancel(m.workspaceId, c.req.valid("param").id, { userId: m.userId }, openedAt ? new Date(openedAt) : undefined, reason && { reason, note })) as never;
    })
    .openapi(undoRoute, async (c) => {
      const m = c.get("member");
      return answer(c as never, await items().undo(m.workspaceId, c.req.valid("param").id, { userId: m.userId, may: (p: string) => can(m.role, p as Permission) })) as never;
    })
    .openapi(resumeRoute, async (c) => {
      const m = c.get("member");
      return answer(c as never, await items().resume(m.workspaceId, c.req.valid("param").id, { userId: m.userId })) as never;
    })
    .openapi(resolveRoute, async (c) => {
      const m = c.get("member");
      return answer(c as never, await items().resolveUnknown(m.workspaceId, c.req.valid("param").id, c.req.valid("json").choice, m.userId)) as never;
    })
    .openapi(moveRoute, async (c) => {
      const m = c.get("member");
      const entries = c.req.valid("json").items.map((e) => ({ id: e.id, plannedAt: new Date(e.plannedAt) }));
      return c.json(toResults(await items().moveItems(m.workspaceId, entries, { userId: m.userId })), 200);
    })
    .openapi(triageRoute, async (c) => {
      const m = c.get("member");
      const t = c.req.valid("json");
      const found = await items().setTriage(m.workspaceId, c.req.valid("param").id, { decideBy: dateOr(t.decideBy), snoozedUntil: dateOr(t.snoozedUntil) });
      return found ? c.json({ ok: true as const }, 200) : c.json({ error: "not_found" }, 404);
    });
}
