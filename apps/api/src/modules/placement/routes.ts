// SPDX-License-Identifier: AGPL-3.0-only
// Placement checks for one Mailbox over HTTP: read where it stands, answer yes or no, stop it, join
// the circle, and read what its checks found and the reports it sent. Answering takes rule.grant (and being the person who connected it), joining being the
// granter; stopping takes any member.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requirePermission, type MemberEnv } from "../identity/index";
import type { Placement, PlacementState } from "./application/grant";
import type { PlacementJoin } from "./application/join";
import { JOIN_CODE } from "./domain/join";

const ErrorBody = z.object({ error: z.string() }).openapi("PlacementError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not allowed, or not the person who connected the Mailbox"),
  404: json(ErrorBody, "No such Mailbox, or placement isn't available here"),
  409: json(ErrorBody, "Refused: old wording, wrong address, already on or nothing to stop"),
};
const params = z.object({ workspaceId: z.uuid(), credentialId: z.uuid() });

const Grant = z.object({
  id: z.uuid(),
  answer: z.enum(["yes", "no"]),
  wordingVersion: z.string(),
  answeredBy: z.uuid(),
  answeredAt: z.iso.datetime(),
  stoppedBy: z.uuid().nullable(),
  stoppedAt: z.iso.datetime().nullable(),
  stopReason: z.string().nullable(),
});
const State = z
  .object({
    address: z.string(),
    status: z.enum(["unanswered", "no", "on", "stopped", "wording_changed", "granter_lost"]),
    wordingVersion: z.string(),
    wording: z.string(),
    mayAnswer: z.boolean(),
    grant: Grant.nullable(),
  })
  .openapi("PlacementState");

const KindResult = z.object({
  sent: z.number().int(),
  counted: z.number().int(),
  // Only verdicts that at least 3 counted reports agree on, each with its count.
  verdicts: z.array(z.object({ verdict: z.string(), reports: z.number().int() })),
  note: z.string().nullable(),
});
export const PlacementResults = z
  .object({
    bootstrap: z.boolean(),
    bootstrapNote: z.string().nullable(),
    weeks: z.array(
      z.object({
        week: z.string(),
        plain: KindResult,
        content: KindResult,
        difference: z.array(z.object({ verdict: z.string(), plain: z.number().int(), content: z.number().int() })),
      }),
    ),
    reportsSent: z.array(z.object({ sender: z.string(), day: z.string(), kind: z.string(), verdict: z.string(), state: z.string(), holdReason: z.string().nullable(), at: z.iso.datetime() })),
  })
  .openapi("PlacementResults");

const path = "/api/w/{workspaceId}/mailboxes/{credentialId}/placement";
const readRoute = createRoute({ method: "get", path, middleware: [requirePermission("workspace.read")], request: { params }, responses: { 200: json(State, "Where placement stands for this Mailbox"), ...errors } });
const answerRoute = createRoute({
  method: "post",
  path,
  middleware: [requirePermission("rule.grant")],
  request: {
    params,
    // No default answer: a request without one is refused, and no answer means no.
    ...body(z.strictObject({ answer: z.enum(["yes", "no"]), wordingVersion: z.string().max(40), confirmAddress: z.string().max(320).optional() })),
  },
  responses: { 200: json(State, "Answer recorded"), ...errors },
});
const stopRoute = createRoute({
  method: "post",
  path: `${path}/stop`,
  middleware: [requirePermission("workspace.read")],
  request: { params, ...body(z.strictObject({ reason: z.string().trim().min(1).max(500) })) },
  responses: { 200: json(z.object({ cancelled: z.number().int(), state: State }), "Stopped; placement Actions not yet sent are cancelled"), ...errors },
});

const code = z.string().trim().regex(JOIN_CODE, "a join code as the signer gave it");
const joinRoute = createRoute({
  method: "post",
  path: `${path}/join`,
  middleware: [requirePermission("rule.grant")],
  request: {
    params,
    ...body(
      z.strictObject({
        part1: code,
        part2: code,
        // Who emailed part 1, and that email's Message-ID as Gmail's "Show original" shows it.
        signer: z.string().trim().toLowerCase().max(320).regex(/^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/, "an email address"),
        messageId: z
          .string()
          .trim()
          .max(998)
          .transform((s) => (s.startsWith("<") ? s : `<${s}>`))
          .pipe(z.string().regex(/^<[^<>\s]+@[^<>\s]+>$/, "a Message-ID such as <id@mail.gmail.com>")),
      }),
    ),
  },
  responses: { 200: json(z.object({ actionId: z.uuid() }).openapi("PlacementJoin"), "The join reply is approved and on its way"), ...errors },
});

const resultsRoute = createRoute({ method: "get", path: `${path}/results`, middleware: [requirePermission("workspace.read")], request: { params }, responses: { 200: json(PlacementResults, "What this Mailbox's checks found, by week, and the reports it sent"), ...errors } });

const out = (s: PlacementState) => ({
  ...s,
  grant: s.grant && { ...s.grant, answer: s.grant.answer as "yes" | "no", answeredAt: s.grant.answeredAt.toISOString(), stoppedAt: s.grant.stoppedAt?.toISOString() ?? null },
});
const STATUS = { not_available: 404, not_found: 404, not_connector: 403, forbidden: 403, stale_wording: 409, already_on: 409, address_mismatch: 409, not_on: 409 } as const;
const JOIN_STATUS = { not_available: 404, not_found: 404, not_granter: 403, not_granted: 409, provider_cannot_join: 409, not_approved: 409 } as const;

export function placementRoutes({ placement, join }: { placement: () => Placement; join: () => PlacementJoin }) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    },
  });
  return app
    .openapi(readRoute, async (c) => {
      const r = await placement().read(c.req.valid("param").workspaceId, c.req.valid("param").credentialId, c.get("member"));
      return r.ok ? c.json(out(r.state), 200) : c.json({ error: r.reason }, STATUS[r.reason]);
    })
    .openapi(answerRoute, async (c) => {
      const r = await placement().answer(c.req.valid("param").workspaceId, c.req.valid("param").credentialId, c.get("member"), c.req.valid("json"));
      return r.ok ? c.json(out(r.state), 200) : c.json({ error: r.reason }, STATUS[r.reason]);
    })
    .openapi(stopRoute, async (c) => {
      const r = await placement().stop(c.req.valid("param").workspaceId, c.req.valid("param").credentialId, c.get("member"), c.req.valid("json").reason);
      return r.ok ? c.json({ cancelled: r.cancelled, state: out(r.state) }, 200) : c.json({ error: r.reason }, STATUS[r.reason]);
    })
    .openapi(resultsRoute, async (c) => {
      const r = await placement().results(c.req.valid("param").workspaceId, c.req.valid("param").credentialId);
      return r.ok ? c.json(PlacementResults.parse(r.results), 200) : c.json({ error: r.reason }, STATUS[r.reason]);
    })
    .openapi(joinRoute, async (c) => {
      const r = await join().join(c.req.valid("param").workspaceId, c.req.valid("param").credentialId, c.get("member"), c.req.valid("json"));
      return r.ok ? c.json({ actionId: r.actionId }, 200) : c.json({ error: r.reason }, JOIN_STATUS[r.reason]);
    });
}
