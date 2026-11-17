// SPDX-License-Identifier: AGPL-3.0-only
// Campaigns over HTTP. identity's Workspace middleware has resolved the caller, and marking a manual
// step done uses the plan's own route.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { can, requirePermission, requireStepUp, type MemberEnv } from "../identity/index";
import { WarningShape } from "../items/index";
import { WARNINGS } from "../outreach/index";
import type { Campaigns } from "./application/create";
import { STATUSES } from "./domain/lifecycle";
import { REJECT_REASONS, REWRITE_PRESETS, rewriteInstruction, type RejectReason, type RewritePreset } from "./domain/rewrite";

const REASON_KEYS = Object.keys(REJECT_REASONS) as [RejectReason, ...RejectReason[]];

const ErrorBody = z.object({ error: z.string() }).openapi("CampaignError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const errors = { 400: json(ErrorBody, "Invalid request"), 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not allowed"), 404: json(ErrorBody, "Not found"), 409: json(ErrorBody, "Conflict") };
const ws = z.object({ workspaceId: z.uuid() });
const one = ws.extend({ id: z.uuid() });
const Ok = z.object({ ok: z.literal(true) });
// Far more than the row limit needs; the row limit is what a person is told about.
const MAX_CSV_CHARS = 2_000_000;

const Summary = z
  .object({
    id: z.uuid(),
    planId: z.uuid(),
    title: z.string(),
    ownerUserId: z.uuid(),
    draftingMode: z.string().nullable(),
    paused: z.boolean(),
    // Derived on every read, never stored (ADR 0023): Ended, Paused, Draft, Awaiting sign-off, Scheduled, No launch date, Running.
    status: z.enum(STATUSES),
    // A later plan version waits for sign-off while an approved one runs.
    changesWaiting: z.boolean(),
  })
  .openapi("CampaignSummary");
const Step = z
  .object({
    key: z.string(),
    on: z.string().nullable(),
    title: z.string().nullable(),
    inPlan: z.boolean(),
    type: z.string(),
    touchClass: z.string().nullable(),
    mailboxCredentialId: z.uuid().nullable(),
    audience: z.string(),
    dmChannel: z.string().nullable(),
    dependsOnStepKey: z.string().nullable(),
    outputConnection: z.string().nullable(),
    outputNetworkId: z.string().nullable(),
    utm: z.boolean(),
    // How an email step is written; null for other steps.
    draftingMode: z.enum(["template", "per_person"]).nullable(),
    // A person cancelled the step, or went ahead without the output it waited on.
    cancelled: z.boolean(),
    waived: z.boolean(),
    // The step this one waits on while that step has no output yet.
    waitingOn: z.string().nullable(),
    output: z.object({ url: z.string(), version: z.number().int(), source: z.enum(["person", "system"]), at: z.iso.datetime() }).nullable(),
    // A plan version changed the step's text or channel, or removed it, and its emails wait on a choice.
    planChange: z
      .object({ kinds: z.array(z.enum(["text", "channel", "removed"])), suggestedTemplate: z.object({ subject: z.string(), text: z.string() }).nullable(), itemId: z.uuid(), expired: z.number().int() })
      .nullable(),
    templateRevision: z.number(),
    // A person's notes for a per-Person step's writer, and the revision a save must name.
    writerNotes: z.string().nullable(),
    writerNotesRevision: z.number(),
    template: z
      .object({ subject: z.string(), text: z.string(), warnings: z.array(WarningShape), needsDecision: z.array(WarningShape) })
      .nullable(),
  })
  .openapi("CampaignStep");
const Listed = Summary.extend({
  goal: z.string().nullable(),
  startsOn: z.string().nullable(),
  /** The launch: the moved anchor if someone moved it, else the plan's start. */
  launchOn: z.string().nullable(),
  endsOn: z.string().nullable(),
  planned: z.number().int(),
  done: z.number().int(),
  sent: z.number().int(),
  replied: z.number().int(),
  needApproval: z.number().int(),
  // The plan's first measure against its target; value is null until someone records a reading.
  measure: z.object({ label: z.string(), target: z.string(), value: z.string().nullable() }).nullable(),
  // The step types the campaign uses, such as email, post or dm.
  channels: z.array(z.string()),
}).openapi("ListedCampaign");
const Detail = Summary.extend({
  // Who started the plan; with Owners and Admins, the one who may delete it while it is a Draft. Null for plans made before this was kept.
  createdBy: z.uuid().nullable(),
  outsideContentAllowed: z.boolean(),
  advance: z.enum(["offer", "run"]),
  advanceSetBy: z.uuid().nullable(),
  advanceUpToCents: z.number().int(),
  goal: z.string().nullable(),
  startsOn: z.string().nullable(),
  anchor: z.object({ on: z.string().nullable(), stepKey: z.string().nullable() }),
  endsOn: z.string().nullable(),
  planned: z.number(),
  done: z.number(),
  skipped: z.number(),
  sent: z.number(),
  replied: z.number(),
  steps: z.array(Step),
  // A person's notes on the Campaign, plain text; "" when none. A save sends `notesRevision` back.
  notes: z.string(),
  notesRevision: z.number().int(),
  notesUpdatedBy: z.uuid().nullable(),
  notesUpdatedAt: z.iso.datetime().nullable(),
}).openapi("Campaign");
const Person = z
  .object({ personId: z.uuid(), status: z.string(), firstName: z.string().nullable(), company: z.string().nullable(), website: z.string().nullable(), email: z.string().nullable(), blocked: z.string().nullable(), country: z.string().nullable(), warnings: z.array(z.enum(WARNINGS)), lastEmailAt: z.iso.datetime().nullable(), conflict: z.object({ itemId: z.uuid(), revision: z.number() }).nullable() })
  .openapi("CampaignPerson");
const RowResult = z
  .object({ row: z.number(), ok: z.boolean(), personId: z.uuid().optional(), missing: z.array(z.string()).optional(), reason: z.string().optional() })
  .openapi("CampaignRowResult");

const listRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/campaigns", middleware: [requirePermission("workspace.read")], request: { params: ws }, responses: { 200: json(z.object({ campaigns: z.array(Listed) }), "Campaigns, each with its dates and counts"), ...errors } });
const getRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/campaigns/{id}", middleware: [requirePermission("workspace.read")], request: { params: one }, responses: { 200: json(Detail, "One campaign"), ...errors } });
// ADR 0023 rule 005: a Draft's creator, or an Owner or Admin, deletes it for good, with its plan and versions.
const deleteDraftRoute = createRoute({ method: "delete", path: "/api/w/{workspaceId}/campaigns/{id}/draft", middleware: [requirePermission("item.edit")], request: { params: one }, responses: { 200: json(Ok, "Deleted"), ...errors } });
// ADR 0023 rule 004: a plan's link leads to its Campaign.
const planCampaignRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/plans/{id}/campaign", middleware: [requirePermission("workspace.read")], request: { params: one }, responses: { 200: json(z.object({ campaignId: z.uuid() }).openapi("PlanCampaign"), "The plan's Campaign"), ...errors } });
const PlanImpact = z
  .object({
    diff: z.object({
      steps: z.array(
        z.discriminatedUnion("kind", [
          z.object({ key: z.string(), kind: z.literal("added") }),
          z.object({ key: z.string(), kind: z.literal("removed") }),
          z.object({ key: z.string(), kind: z.literal("changed"), redatedDays: z.number().int(), retitled: z.boolean(), channel: z.boolean(), text: z.boolean() }),
        ]),
      ),
      plan: z.array(z.enum(["goal", "audience", "measures", "budget", "assumptions"])),
    }),
    affected: z.array(z.object({ key: z.string(), kinds: z.array(z.enum(["text", "channel", "removed"])), counts: z.record(z.string(), z.number().int()) })),
    titles: z.record(z.string(), z.string()),
  })
  .openapi("CampaignPlanImpact");
const planImpactRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/plan-impact",
  middleware: [requirePermission("workspace.read")],
  request: { params: one },
  responses: { 200: json(PlanImpact, "What approving the plan's draft would hold"), ...errors },
});
const peopleRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/people",
  middleware: [requirePermission("workspace.read")],
  request: { params: one, query: z.object({ cursor: z.uuid().optional() }) },
  responses: { 200: json(z.object({ people: z.array(Person), next: z.uuid().nullable() }), "One page of people"), ...errors },
});
const addRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/{id}/people",
  middleware: [requirePermission("item.edit")],
  request: { params: one, ...body(z.strictObject({ csv: z.string().max(MAX_CSV_CHARS) })) },
  responses: { 200: json(z.object({ results: z.array(RowResult) }), "One result per row"), ...errors },
});
const removeRoute = createRoute({
  method: "delete",
  path: "/api/w/{workspaceId}/campaigns/{id}/people/{personId}",
  middleware: [requirePermission("item.edit")],
  request: { params: one.extend({ personId: z.uuid() }) },
  responses: { 200: json(Ok, "Removed"), ...errors },
});
const stepRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}",
  middleware: [requirePermission("item.edit")],
  request: {
    params: one.extend({ key: z.string().min(1).max(200) }),
    ...body(
      z.strictObject({
        type: z.enum(["email", "manual", "post", "dm", "clips", "seo_brief"]),
        touchClass: z.enum(["cold", "consented_marketing"]).nullable(),
        mailboxCredentialId: z.uuid().nullable(),
        audience: z.enum(["everyone", "no_reply_yet"]),
        dmChannel: z.enum(["linkedin", "x"]).nullable().optional(),
        dependsOnStepKey: z.string().regex(/^[a-z0-9_-]{1,64}$/).nullable().optional(),
        outputConnection: z.string().min(1).max(200).nullable().optional(),
        outputNetworkId: z.string().max(200).nullable().optional(),
        utm: z.boolean().optional(),
      }),
    ),
  },
  responses: { 200: json(Ok, "Saved"), ...errors },
});

const StepOutputBody = z.object({ stepKey: z.string(), url: z.string(), version: z.number().int(), source: z.enum(["person", "system"]), at: z.iso.datetime() }).openapi("StepOutput");

// A manual step's output, a URL, recorded by a person. Each change is a new version.
const outputRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/output",
  middleware: [requirePermission("item.edit")],
  request: {
    params: one.extend({ key: z.string().min(1).max(200) }),
    ...body(z.strictObject({ url: z.string().min(1).max(2048) })),
  },
  responses: { 200: json(StepOutputBody, "Recorded"), ...errors },
});

const postsRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/posts",
  middleware: [requirePermission("item.edit")],
  request: {
    params: one.extend({ key: z.string().min(1).max(200) }),
    ...body(
      z.strictObject({
        plannedAt: z.iso.datetime(),
        targets: z.array(z.strictObject({ connection: z.string().min(1).max(100), credentialId: z.uuid().nullable(), networkId: z.string().min(1).max(200).nullable(), text: z.string().min(1).max(70_000), followUps: z.array(z.string().min(1).max(70_000)).max(10).optional(), mediaId: z.uuid().nullable().optional(), mediaIds: z.array(z.uuid()).min(1).max(4).optional(), alt: z.array(z.string().max(1000)).max(4).optional() })).min(1).max(50),
      }),
    ),
  },
  responses: { 200: json(z.object({ results: z.array(z.object({ connection: z.string(), networkId: z.string().nullable(), ok: z.boolean(), itemId: z.uuid().optional(), mode: z.enum(["publish", "manual"]).optional(), reason: z.string().optional(), detail: z.string().optional() })) }), "One result per account"), ...errors },
});

const clipStepKey = one.extend({ key: z.string().min(1).max(200) });
const ClipAccountBody = z.strictObject({ connection: z.string().min(1).max(100), credentialId: z.uuid().nullable(), networkId: z.string().min(1).max(200).nullable() });
const PostResults = z.object({ results: z.array(z.object({ connection: z.string(), networkId: z.string().nullable(), ok: z.boolean(), itemId: z.uuid().optional(), mode: z.enum(["publish", "manual"]).optional(), reason: z.string().optional(), detail: z.string().optional() })) });
const makeClipsRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/clips",
  middleware: [requirePermission("item.edit")],
  description: "Adds a recording to a clips step and starts clipping it; refused while another recording on the step is still being clipped. When the clips are cut, each goes to one of the accounts as a post to approve, a day apart per account from firstAt.",
  request: { params: clipStepKey, ...body(z.strictObject({ sourceMediaId: z.uuid(), accounts: z.array(ClipAccountBody).min(1).max(20), firstAt: z.iso.datetime() })) },
  responses: { 202: json(z.object({ runId: z.uuid() }), "Clipping"), ...errors, 400: json(ErrorBody, "not_a_clips_step, or not_available: clipping needs a self-hosted server") },
});
const clipStepRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/clips",
  middleware: [requirePermission("workspace.read")],
  request: { params: clipStepKey },
  responses: {
    200: json(
      z.object({ recordings: z.array(z.object({ setup: z.unknown(), run: z.unknown(), clips: z.array(z.unknown()), unposted: z.array(z.string()), idle: z.array(ClipAccountBody) })), lastAccounts: z.array(ClipAccountBody) }).openapi("ClipStep"),
      "Each recording, newest first: its run, each clip with its posts, what was dropped and what was left out; and the accounts the last one used",
    ),
    ...errors,
  },
});
const clipCaptionRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/clips/{clipId}/caption",
  middleware: [requirePermission("item.edit")],
  request: { params: clipStepKey.extend({ clipId: z.uuid() }), ...body(z.strictObject({ text: z.string().trim().min(1).max(70_000) })) },
  responses: { 200: json(PostResults, "The clip's post, drafted again"), ...errors },
});
const BriefState = z
  .object({ state: z.enum(["running", "failed", "no_brief", "waiting", "approved", "dismissed"]), reason: z.string().optional(), itemId: z.uuid().optional() })
  .openapi("StepBriefState");
const makeBriefRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/brief",
  middleware: [requirePermission("item.edit")],
  description: "Saves an SEO brief step's page and search and starts a Brief on them. The page is left out when the step waits on another step, whose output is the page. Approving the Brief publishes nothing.",
  request: { params: clipStepKey, ...body(z.strictObject({ page: z.string().min(1).max(2048).nullable().optional(), query: z.string().max(400) })) },
  responses: { 202: json(z.object({ runId: z.uuid() }), "Writing the Brief"), ...errors, 400: json(ErrorBody, "not_a_brief_step, bad_url, bad_query, page_and_dependency, a page the reader can't read, or cloud_unavailable: Briefs need a self-hosted server") },
});
const briefStepRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/brief",
  middleware: [requirePermission("workspace.read")],
  request: { params: clipStepKey },
  responses: {
    200: json(
      z.object({ setup: z.object({ page: z.string().nullable(), query: z.string() }).nullable(), brief: BriefState.nullable(), available: z.boolean() }).openapi("BriefStep"),
      "The step's page and search, where its latest Brief stands, and whether Briefs can run here",
    ),
    ...errors,
  },
});

const modeRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/drafting-mode",
  middleware: [requirePermission("item.edit")],
  request: { params: one, ...body(z.strictObject({ mode: z.enum(["template", "per_person"]) })) },
  responses: { 200: json(Ok, "Saved"), ...errors },
});
// It can steer what is sent unread, so it is asked like a rule grant.
const outsideContentRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/{id}/outside-content",
  middleware: [requirePermission("rule.grant"), requireStepUp()],
  request: { params: one, body: { required: true, content: { "application/json": { schema: z.strictObject({ allowed: z.boolean() }) } } } },
  responses: { 200: json(Ok, "Saved"), ...errors },
});
// Run lets model work start with no click, so it is granted like a rule.
const advanceRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/{id}/advance",
  middleware: [requirePermission("rule.grant"), requireStepUp()],
  request: { params: one, ...body(z.strictObject({ advance: z.enum(["offer", "run"]), timeZone: z.string().max(64).optional() })) },
  responses: { 200: json(Ok, "Saved"), ...errors },
});
const draftRunRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/draft-run",
  middleware: [requirePermission("item.edit")],
  request: { params: one.extend({ key: z.string().min(1).max(200) }) },
  responses: { 200: json(z.object({ runId: z.uuid() }), "Started"), ...errors },
});

const pauseRoute = createRoute({ method: "post", path: "/api/w/{workspaceId}/campaigns/{id}/pause", middleware: [requirePermission("item.approve")], request: { params: one }, responses: { 200: json(Ok, "Paused"), ...errors } });
const resumeRoute = createRoute({ method: "post", path: "/api/w/{workspaceId}/campaigns/{id}/resume", middleware: [requirePermission("item.approve")], request: { params: one }, responses: { 200: json(Ok, "Running again"), ...errors } });
const stepKey = one.extend({ key: z.string().min(1).max(200) });
const validTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
const templateRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/template",
  middleware: [requirePermission("item.edit")],
  request: { params: stepKey, ...body(z.strictObject({ revision: z.number().int().nonnegative(), subject: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(5000) })) },
  responses: { 200: json(z.object({ revision: z.number(), revised: z.number(), failed: z.array(z.object({ personId: z.uuid(), reason: z.string() })) }), "Saved, and unsent drafts revised"), ...errors },
});
const stepModeRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/drafting-mode",
  middleware: [requirePermission("item.edit")],
  request: { params: stepKey, ...body(z.strictObject({ mode: z.enum(["template", "per_person"]) })) },
  responses: { 200: json(Ok, "Saved"), ...errors },
});
const makeDraftsRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/make-drafts",
  middleware: [requirePermission("item.edit")],
  request: { params: stepKey, ...body(z.strictObject({ timeZone: z.string().max(100).refine(validTimeZone, "bad_time_zone") })) },
  responses: {
    200: json(
      z.object({
        results: z.array(
          z.object({
            personId: z.uuid(),
            email: z.string().nullable(),
            ok: z.boolean(),
            itemId: z.uuid().optional(),
            already: z.boolean().optional(),
            reason: z.string().optional(),
            leftOut: z.object({ reason: z.string(), fields: z.array(z.string()).optional() }).optional(),
          }),
        ),
      }),
      "One result per Person",
    ),
    ...errors,
  },
});

const LeftOut = z.object({ reason: z.string(), fields: z.array(z.string()).optional() });

// DM steps: drafted here, sent by a person by hand. No approval, because Direx sends nothing.
const Dm = z.object({ id: z.uuid(), personId: z.uuid(), channel: z.string(), profileUrl: z.string(), text: z.string(), copiedAt: z.string().nullable(), sentAt: z.string().nullable() }).openapi("CampaignDm");
const dmParams = ws.extend({ dmId: z.uuid() });
const dmTextRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/dm-text",
  middleware: [requirePermission("item.edit")],
  request: { params: stepKey, ...body(z.strictObject({ revision: z.number().int().nonnegative(), text: z.string().trim().min(1).max(2000) })) },
  responses: { 200: json(z.object({ revision: z.number(), warnings: z.array(z.string()) }), "Saved; DMs already made keep their text"), ...errors },
});
const makeDmsRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/dms",
  middleware: [requirePermission("item.edit")],
  request: { params: stepKey },
  responses: {
    200: json(z.object({ results: z.array(z.object({ personId: z.uuid(), email: z.string().nullable(), ok: z.boolean(), itemId: z.uuid().optional(), already: z.boolean().optional(), reason: z.string().optional(), leftOut: LeftOut.optional() })) }), "One result per Person"),
    ...errors,
  },
});
const listDmsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/dms",
  middleware: [requirePermission("workspace.read")],
  request: { params: stepKey },
  responses: { 200: json(z.object({ dms: z.array(Dm) }), "The step's DMs"), ...errors },
});
const copyDmRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/dms/{dmId}/copied",
  middleware: [requirePermission("item.edit")],
  request: { params: dmParams },
  responses: { 200: json(z.object({ direxTouchNear: z.boolean() }), "Recorded; true when Direx emailed them, or will, within 3 days"), ...errors },
});
const markDmSentRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/dms/{dmId}/mark-sent",
  middleware: [requirePermission("item.edit")],
  request: { params: dmParams },
  responses: { 200: json(Dm, "Recorded as sent, and logged as a touch"), ...errors },
});
const previewRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/drafts-preview",
  middleware: [requirePermission("workspace.read")],
  request: { params: stepKey },
  responses: {
    200: json(
      z
        .object({
          willMake: z.number(),
          already: z.number(),
          leftOut: z.array(z.object({ email: z.string().nullable(), leftOut: LeftOut })),
          sample: z.object({ email: z.string().nullable(), subject: z.string(), text: z.string() }).nullable(),
        })
        .openapi("CampaignDraftsPreview"),
      "What Make drafts would do",
    ),
    ...errors,
  },
});

const personPreviewRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/person-preview",
  middleware: [requirePermission("workspace.read")],
  request: { params: stepKey },
  responses: {
    200: json(
      z.object({ willWrite: z.number(), generic: z.number(), already: z.number(), leftOut: z.array(z.object({ email: z.string().nullable(), leftOut: LeftOut })), worstCaseCents: z.number(), days: z.number().nullable() }).openapi("CampaignPersonPreview"),
      "What writing per address would do",
    ),
    ...errors,
  },
});
const personDraftsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/person-drafts",
  middleware: [requirePermission("workspace.read")],
  request: { params: stepKey },
  responses: {
    200: json(
      z.object({
        drafts: z.array(
          z
            .object({ personId: z.uuid(), itemId: z.uuid(), email: z.string().nullable(), state: z.string(), editable: z.boolean(), warnings: z.array(WarningShape), subject: z.string(), text: z.string(), spans: z.array(z.object({ text: z.string(), kind: z.enum(["same", "added"]) })).nullable() })
            .openapi("CampaignPersonDraft"),
        ),
      }),
      "Each Person's draft",
    ),
    ...errors,
  },
});
const editPersonDraftRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/people/{personId}/draft",
  middleware: [requirePermission("item.edit")],
  request: { params: stepKey.extend({ personId: z.uuid() }), ...body(z.strictObject({ subject: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(5000) })) },
  responses: { 200: json(Ok, "Saved, and waiting for approval"), ...errors },
});
const writePerPersonRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/write-per-person",
  middleware: [requirePermission("item.edit")],
  request: { params: stepKey, ...body(z.strictObject({ timeZone: z.string().max(100).refine(validTimeZone, "bad_time_zone") })) },
  responses: { 200: json(z.object({ started: z.number(), runIds: z.array(z.uuid()), failed: z.array(z.object({ personId: z.uuid(), reason: z.string() })) }), "One run per Person"), ...errors },
});

// Edits a person keeps making on one step's drafts, as `-removed` or `+added` phrases.
const repeatedEditsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/repeated-edits",
  middleware: [requirePermission("workspace.read")],
  request: { params: stepKey },
  responses: { 200: json(z.object({ edits: z.array(z.object({ phrase: z.string(), count: z.number() })) }), "Repeated edits"), ...errors },
});
// Reasons a person keeps giving on one step's drafts, with the words a writer note would hold.
const repeatedReasonsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/repeated-reasons",
  middleware: [requirePermission("workspace.read")],
  request: { params: stepKey },
  responses: { 200: json(z.object({ reasons: z.array(z.object({ reason: z.enum(REASON_KEYS), count: z.number(), words: z.string() })) }), "Repeated reasons"), ...errors },
});
// Writing context is not approving anything, so a contributor may. A Draft takes notes too (ADR 0023, revised 2026-11-14).
const notesRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/notes",
  middleware: [requirePermission("item.edit")],
  request: { params: one, ...body(z.strictObject({ notes: z.string().max(10000), revision: z.number().int().min(0) })) },
  responses: { 200: json(z.object({ revision: z.number() }), "Saved"), ...errors },
});
const writerNotesRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/writer-notes",
  middleware: [requirePermission("item.approve")],
  request: { params: stepKey, ...body(z.strictObject({ notes: z.string().max(2000), revision: z.number().int().min(0) })) },
  responses: { 200: json(z.object({ revision: z.number() }), "Saved"), ...errors },
});
// Without confirm, only what rewriting the unapproved drafts would take; with it, the rewrites start.
const redraftStepRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/redraft",
  middleware: [requirePermission("item.edit")],
  request: { params: stepKey, ...body(z.strictObject({ confirm: z.boolean(), timeZone: z.string().max(100).refine(validTimeZone, "bad_time_zone") })) },
  responses: { 200: json(z.object({ runs: z.number(), worstCaseCents: z.number(), started: z.number(), runIds: z.array(z.uuid()) }), "Runs and cost, and the runs that started"), ...errors },
});
// One email or campaign post waiting for approval, rewritten now by its writer: a preset, a reason with optional
// words, or the person's own words. A reason is recorded against its step; `openedAt` is when the review page opened it.
const rewriteRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/items/{id}/rewrite",
  middleware: [requirePermission("item.edit")],
  request: {
    params: one,
    ...body(
      z.strictObject({
        preset: z.enum(Object.keys(REWRITE_PRESETS) as [RewritePreset, ...RewritePreset[]]).optional(),
        reason: z.enum(REASON_KEYS).optional(),
        instruction: z.string().max(300).optional(),
        openedAt: z.iso.datetime().optional(),
        timeZone: z.string().max(100).refine(validTimeZone, "bad_time_zone"),
      }),
    ),
  },
  responses: { 200: json(z.object({ runId: z.uuid() }), "The rewrite started"), ...errors },
});

// What importing People will start for the first email step, shown before confirm.
const draftingPreviewRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/drafting-preview",
  middleware: [requirePermission("workspace.read")],
  request: { params: one },
  responses: {
    200: json(
      z
        .object({ stepKey: z.string(), mode: z.enum(["template", "per_person"]), people: z.number(), already: z.number(), leftOut: z.array(z.object({ email: z.string().nullable(), leftOut: LeftOut })), runs: z.number(), worstCaseCents: z.number(), days: z.number().nullable() })
        .openapi("CampaignDraftingPreview"),
      "What drafting on import would take",
    ),
    ...errors,
  },
});
const draftingConfirmRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/{id}/drafting-confirm",
  middleware: [requirePermission("item.edit")],
  request: { params: one, ...body(z.strictObject({ timeZone: z.string().max(100).refine(validTimeZone, "bad_time_zone") })) },
  responses: { 200: json(z.object({ stepKey: z.string(), mode: z.enum(["template", "per_person"]), made: z.number(), started: z.number() }), "Drafting started for People without a draft"), ...errors },
});

const progressRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/progress",
  middleware: [requirePermission("workspace.read")],
  request: { params: one },
  responses: {
    200: json(
      z
        .object({
          steps: z.array(
            z.object({ stepKey: z.string(), title: z.string(), mode: z.enum(["template", "per_person"]), written: z.number(), toWrite: z.number(), readyOn: z.string().nullable(), waiting: z.array(z.object({ label: z.string(), count: z.number() })) }),
          ),
          // Every step's Items by state, dated or not; a state with none is left out.
          counts: z.array(z.object({ stepKey: z.string(), state: z.enum(["draft", "needs_approval", "scheduled", "sent", "applied", "held", "blocked", "cancelled"]), n: z.number().int() })),
        })
        .openapi("CampaignProgress"),
      "How far each email step's drafting has got, and each step's Items by state",
    ),
    ...errors,
  },
});

// What is known of how a Campaign went. Only numbers Direx records; opens and clicks are not among them.
const Results = z
  .object({
    sent: z.array(z.object({ kind: z.enum(["email", "post", "dm"]), channel: z.string(), n: z.number().int() })),
    email: z.object({ replied: z.number().int(), bounced: z.number().int(), optedOut: z.number().int() }).nullable(),
    measures: z.array(z.object({ key: z.string(), label: z.string(), target: z.string(), value: z.string().nullable(), observedOn: z.string().nullable() })),
  })
  .openapi("CampaignResults");
const resultsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/results",
  middleware: [requirePermission("workspace.read")],
  request: { params: one },
  responses: { 200: json(Results, "Sends by channel, what came back on email, and each measure against its target"), ...errors },
});

// What Direx did for one Campaign, newest first.
const activityRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaigns/{id}/activity",
  middleware: [requirePermission("workspace.read")],
  request: { params: one },
  responses: {
    200: json(
      z.object({ events: z.array(z.object({ at: z.iso.datetime(), text: z.string(), by: z.enum(["person", "direx"]), undo: z.object({ kind: z.literal("launch"), on: z.iso.date() }).nullable() })) }).openapi("CampaignActivity"),
      "What Direx did, newest first; a line with undo can be reversed",
    ),
    ...errors,
  },
});

// Moves the launch every step keeps its distance from; with preview, only says what it would do.
const anchorRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/campaigns/{id}/anchor",
  middleware: [requirePermission("item.edit")],
  request: { params: one, ...body(z.union([z.strictObject({ on: z.iso.date(), preview: z.boolean().optional() }), z.strictObject({ stepKey: z.string().min(1).max(64).nullable() })])) },
  responses: {
    200: json(
      z.object({ from: z.string(), to: z.string(), moved: z.number(), kept: z.number(), backToApproval: z.number(), overCap: z.number(), failed: z.number() }).openapi("CampaignAnchorMove"),
      "What moved, or would move",
    ),
    ...errors,
  },
});

// Each Campaign's launch in a date range, for the Calendar's markers.
const launchesRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaign-launches",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, query: z.object({ from: z.iso.date(), to: z.iso.date() }) },
  responses: { 200: json(z.object({ launches: z.array(z.object({ campaignId: z.uuid(), title: z.string(), on: z.string() })) }).openapi("CampaignLaunches"), "Launches in the range"), ...errors },
});
// Steps the plan dates in a range that nothing has been drafted for yet, for Home's week.
const emptyStepsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/campaign-steps",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, query: z.object({ from: z.iso.date(), to: z.iso.date() }) },
  responses: {
    200: json(
      z.object({ steps: z.array(z.object({ campaignId: z.uuid(), campaign: z.string(), stepKey: z.string(), title: z.string(), on: z.string() })) }).openapi("CampaignStepsWithoutDrafts"),
      "Planned steps with nothing drafted yet",
    ),
    ...errors,
  },
});
// The answer to a step others wait on whose output never came.
const stallRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/stall",
  middleware: [requirePermission("item.edit")],
  request: { params: stepKey, ...body(z.strictObject({ choice: z.enum(["wait", "go_ahead", "cancel"]) })) },
  responses: { 200: json(z.object({ cancelled: z.array(z.string()), waived: z.array(z.string()), itemsCancelled: z.number() }), "Answered"), ...errors },
});

export function campaignRoutes(deps: { campaigns: () => Campaigns }) {
  const app = new OpenAPIHono<MemberEnv>();
  app.openapi(launchesRoute, async (c) => {
    const { from, to } = c.req.valid("query");
    return c.json({ launches: await deps.campaigns().launchesBetween(c.req.valid("param").workspaceId, from, to) }, 200);
  });
  app.openapi(emptyStepsRoute, async (c) => {
    const { from, to } = c.req.valid("query");
    return c.json({ steps: await deps.campaigns().stepsWithoutDrafts(c.req.valid("param").workspaceId, from, to) }, 200);
  });
  app.openapi(stallRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().resolveStall(workspaceId, id, key, c.req.valid("json").choice, { userId: c.get("member").userId });
    if (r.ok) return c.json({ cancelled: r.cancelled, waived: r.waived, itemsCancelled: r.itemsCancelled }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(anchorRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const actor = { userId: c.get("member").userId };
    if ("stepKey" in input) {
      const r = await deps.campaigns().followStep(workspaceId, id, input.stepKey, actor);
      if (r.ok) return c.json({ from: "", to: "", moved: 0, kept: 0, backToApproval: 0, overCap: 0, failed: 0 }, 200);
      return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
    }
    const r = await deps.campaigns().moveAnchor(workspaceId, id, { on: input.on }, actor, { preview: input.preview ?? false });
    if (r.ok) return c.json({ from: r.from, to: r.to, moved: r.moved, kept: r.kept, backToApproval: r.backToApproval, overCap: r.overCap, failed: r.failed }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(resultsRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.campaigns().outcomes(workspaceId, id);
    return r ? c.json(r, 200) : c.json({ error: "not_found" }, 404);
  });
  app.openapi(activityRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.campaigns().activity(workspaceId, id);
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json({ events: r.map((e) => ({ at: e.at.toISOString(), text: e.text, by: e.by, undo: e.undo ?? null })) }, 200);
  });
  app.openapi(progressRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.campaigns().progress(workspaceId, id);
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json({ steps: r.steps.map((s) => ({ stepKey: s.stepKey, title: s.title, mode: s.mode, written: s.written, toWrite: s.toWrite, readyOn: s.readyOn, waiting: s.waiting })), counts: r.counts }, 200);
  });
  app.openapi(draftingPreviewRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.campaigns().previewDrafting(workspaceId, id);
    if (r.ok) return c.json({ stepKey: r.stepKey, mode: r.mode, people: r.people, already: r.already, leftOut: r.leftOut, runs: r.runs, worstCaseCents: r.worstCaseCents, days: r.days }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(draftingConfirmRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.campaigns().confirmDrafting(workspaceId, id, { timeZone: c.req.valid("json").timeZone, userId: c.get("member").userId });
    if (r.ok) return c.json({ stepKey: r.stepKey, mode: r.mode, made: r.made, started: r.started }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(personPreviewRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().personPreview(workspaceId, id, key);
    if (r.ok) return c.json({ willWrite: r.willWrite, generic: r.generic, already: r.already, leftOut: r.leftOut, worstCaseCents: r.worstCaseCents, days: r.days }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(personDraftsRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    return c.json({ drafts: await deps.campaigns().personDrafts(workspaceId, id, key) }, 200);
  });
  app.openapi(editPersonDraftRoute, async (c) => {
    const { workspaceId, id, key, personId } = c.req.valid("param");
    const r = await deps.campaigns().editPersonDraft(workspaceId, id, key, personId, { ...c.req.valid("json"), userId: c.get("member").userId });
    if (r.ok) return c.json({ ok: true as const }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(repeatedReasonsRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    return c.json({ reasons: await deps.campaigns().repeatedReasons(workspaceId, id, key) }, 200);
  });
  app.openapi(repeatedEditsRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    return c.json({ edits: await deps.campaigns().repeatedEdits(workspaceId, id, key) }, 200);
  });
  app.openapi(notesRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.campaigns().setNotes(workspaceId, id, { ...c.req.valid("json"), userId: c.get("member").userId });
    if (r.ok) return c.json({ revision: r.revision }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(writerNotesRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().setWriterNotes(workspaceId, id, key, c.req.valid("json"));
    if (r.ok) return c.json({ revision: r.revision }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(redraftStepRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().redraftStep(workspaceId, id, key, { ...c.req.valid("json"), userId: c.get("member").userId });
    if (r.ok) return c.json({ runs: r.runs, worstCaseCents: r.worstCaseCents, started: r.started, runIds: r.runIds }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(rewriteRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const { timeZone, openedAt, ...asked } = c.req.valid("json");
    const instruction = rewriteInstruction(asked);
    if (!instruction) return c.json({ error: "preset_or_instruction" }, 400);
    const r = await deps
      .campaigns()
      .rewrite(workspaceId, id, { instruction, timeZone, userId: c.get("member").userId, reason: asked.reason, note: asked.reason && asked.instruction, openedAt: openedAt ? new Date(openedAt) : undefined });
    if (r.ok) return c.json({ runId: r.runId }, 200);
    return c.json({ error: r.reason }, 409);
  });
  app.openapi(writePerPersonRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().writePerPerson(workspaceId, id, key, { timeZone: c.req.valid("json").timeZone, userId: c.get("member").userId });
    if (r.ok) return c.json({ started: r.started, runIds: r.runIds, failed: r.failed }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(previewRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().previewDrafts(workspaceId, id, key);
    if (r.ok) return c.json({ willMake: r.willMake, already: r.already, leftOut: r.leftOut, sample: r.sample }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(outsideContentRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.campaigns().setOutsideContent(workspaceId, id, { allowed: c.req.valid("json").allowed, userId: c.get("member").userId });
    return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(advanceRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const a = c.req.valid("json");
    const r = await deps.campaigns().setAdvance(workspaceId, id, { advance: a.advance, timeZone: a.timeZone ?? null, userId: c.get("member").userId });
    return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 400);
  });
  app.openapi(pauseRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.campaigns().pause(workspaceId, id, c.get("member").userId);
    return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 404);
  });
  app.openapi(resumeRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.campaigns().resume(workspaceId, id, c.get("member").userId);
    return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 404);
  });
  app.openapi(templateRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().saveTemplate(workspaceId, id, key, { ...c.req.valid("json"), userId: c.get("member").userId });
    if (r.ok) return c.json({ revision: r.revision, revised: r.revised, failed: r.failed }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(makeDraftsRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().makeDrafts(workspaceId, id, key, { timeZone: c.req.valid("json").timeZone, userId: c.get("member").userId });
    if (r.ok) return c.json({ results: r.results }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(modeRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.campaigns().setDraftingMode(workspaceId, id, c.req.valid("json").mode);
    if (r.ok) return c.json({ ok: true as const }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(stepModeRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().setStepDraftingMode(workspaceId, id, key, c.req.valid("json").mode);
    if (r.ok) return c.json({ ok: true as const }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(draftRunRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().startDraft(workspaceId, id, key, c.get("member").userId);
    if (r.ok) return c.json({ runId: r.run.id }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(listRoute, async (c) => c.json({ campaigns: await deps.campaigns().list(c.req.valid("param").workspaceId) }, 200));
  app.openapi(getRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    await deps.campaigns().results(workspaceId, id);
    const found = await deps.campaigns().campaign(workspaceId, id);
    return found ? c.json(found, 200) : c.json({ error: "not_found" }, 404);
  });
  app.openapi(deleteDraftRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const m = c.get("member");
    const r = await deps.campaigns().deleteDraft(workspaceId, id, { userId: m.userId, mayDeleteAny: can(m.role, "campaign.delete_draft") });
    if (r.ok) return c.json({ ok: true as const }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : r.reason === "forbidden" ? 403 : 409);
  });
  app.openapi(planCampaignRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const campaignId = await deps.campaigns().campaignIdOfPlan(workspaceId, id);
    return campaignId ? c.json({ campaignId }, 200) : c.json({ error: "not_found" }, 404);
  });
  app.openapi(planImpactRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const impact = await deps.campaigns().planImpact(workspaceId, id);
    return impact ? c.json(impact, 200) : c.json({ error: "not_found" }, 404);
  });
  app.openapi(peopleRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    return c.json(await deps.campaigns().people(workspaceId, id, c.req.valid("query").cursor), 200);
  });
  app.openapi(addRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.campaigns().addPeople(workspaceId, id, { csv: c.req.valid("json").csv, userId: c.get("member").userId });
    if (r.ok) return c.json({ results: r.results }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 400);
  });
  app.openapi(removeRoute, async (c) => {
    const { workspaceId, id, personId } = c.req.valid("param");
    const r = await deps.campaigns().removePerson(workspaceId, id, personId, c.get("member").userId);
    return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 404);
  });
  app.openapi(stepRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().setupStep(workspaceId, id, key, c.req.valid("json"));
    if (r.ok) return c.json({ ok: true as const }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 400);
  });
  app.openapi(outputRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().recordOutput(workspaceId, id, key, c.req.valid("json").url, { userId: c.get("member").userId });
    if (r.ok) return c.json({ ...r.output, at: r.output.at.toISOString() }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : r.reason === "same_url" ? 409 : 400);
  });
  app.openapi(postsRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const { plannedAt, targets } = c.req.valid("json");
    const r = await deps.campaigns().draftPosts(workspaceId, id, key, { plannedAt: new Date(plannedAt), targets }, c.get("member").userId);
    if (r.ok) return c.json({ results: r.results as { connection: string; networkId: string | null; ok: boolean }[] }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 400);
  });
  app.openapi(makeClipsRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const { sourceMediaId, accounts, firstAt } = c.req.valid("json");
    const r = await deps.campaigns().makeClips(workspaceId, id, key, { sourceMediaId, accounts, firstAt: new Date(firstAt) }, c.get("member").userId);
    if (r.ok) return c.json({ runId: r.runId }, 202);
    return c.json({ error: r.reason }, r.reason === "in_progress" ? 409 : r.reason === "not_found" || r.reason === "step_not_in_plan" ? 404 : 400);
  });
  app.openapi(clipStepRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().clipStep(workspaceId, id, key);
    if (!r.ok) return c.json({ error: r.reason }, 404);
    const { ok: _, ...view } = r;
    return c.json(view, 200);
  });
  app.openapi(makeBriefRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const { page, query } = c.req.valid("json");
    const r = await deps.campaigns().makeBrief(workspaceId, id, key, { page: page ?? null, query }, c.get("member").userId);
    if (r.ok) return c.json({ runId: r.runId }, 202);
    const status = r.reason === "not_found" || r.reason === "step_not_in_plan" ? 404 : ["waiting_on_step", "brief_running", "brief_approved", "brief_waiting"].includes(r.reason) ? 409 : 400;
    return c.json({ error: r.reason }, status);
  });
  app.openapi(briefStepRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().briefStep(workspaceId, id, key);
    if (!r.ok) return c.json({ error: r.reason }, 404);
    const { ok: _, ...view } = r;
    return c.json(view, 200);
  });
  app.openapi(clipCaptionRoute, async (c) => {
    const { workspaceId, id, key, clipId } = c.req.valid("param");
    const r = await deps.campaigns().editClipCaption(workspaceId, id, key, clipId, c.req.valid("json").text);
    if (r.ok) return c.json({ results: r.results as { connection: string; networkId: string | null; ok: boolean }[] }, 200);
    return c.json({ error: r.reason }, 404);
  });
  app.openapi(dmTextRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().saveDmText(workspaceId, id, key, c.req.valid("json"));
    if (r.ok) return c.json({ revision: r.revision, warnings: r.warnings }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(makeDmsRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    const r = await deps.campaigns().makeDms(workspaceId, id, key);
    if (r.ok) return c.json({ results: r.results }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(listDmsRoute, async (c) => {
    const { workspaceId, id, key } = c.req.valid("param");
    return c.json({ dms: await deps.campaigns().dms(workspaceId, id, key) }, 200);
  });
  app.openapi(copyDmRoute, async (c) => {
    const { workspaceId, dmId } = c.req.valid("param");
    const r = await deps.campaigns().copyDm(workspaceId, dmId);
    if (r.ok) return c.json({ direxTouchNear: r.direxTouchNear }, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  app.openapi(markDmSentRoute, async (c) => {
    const { workspaceId, dmId } = c.req.valid("param");
    const r = await deps.campaigns().markDmSent(workspaceId, dmId, c.get("member").userId);
    if (r.ok) return c.json(r.dm, 200);
    return c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
  });
  return app;
}
