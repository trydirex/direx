// SPDX-License-Identifier: AGPL-3.0-only
// The Server page's routes (ADR 0024): the sign-up policy, mail status, the accounts and their
// Server admins. Only a Server admin reaches them, and being one opens no Workspace (rule 007).
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import type { Auth } from "./adapters/auth";
import type { Mailer } from "./adapters/mail";
import { addServerAdmin, isServerAdmin, listAccounts, removeServerAdmin, setSignupPolicy } from "./application/admission";
import type { Admission } from "./domain/admission";
import { readSession, STEP_UP_MS } from "./middleware";

export type ServerAdminEnv = { Variables: { admin: { userId: string; signedInAt: Date } } };
type Env = ServerAdminEnv;

/** Only a signed-in Server admin passes; sets `admin`. Being one opens no Workspace (rule 007). */
export const requireServerAdmin = (auth: () => Auth) =>
  createMiddleware<Env>(async (c, next) => {
    const s = await readSession(auth, c);
    if (!s) return c.json({ error: "not_signed_in" }, 401);
    if (!(await isServerAdmin(s.user.id))) return c.json({ error: "forbidden" }, 403);
    c.set("admin", { userId: s.user.id, signedInAt: new Date(s.session.createdAt) });
    await next();
  });

/** A Server admin signed in within the step-up window. */
export const adminSteppedUp = (a: Env["Variables"]["admin"]) => Date.now() - a.signedInAt.getTime() <= STEP_UP_MS;

const ErrorBody = z.object({ error: z.string() }).openapi("Error");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not a Server admin, or step-up required"),
  404: json(ErrorBody, "No such account or Server admin"),
  409: json(ErrorBody, "Refused: mail_failing, last_server_admin"),
};
const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");
const Policy = z
  .object({ policy: z.enum(["invite_only", "domains", "anyone"]), domains: z.array(z.string().trim().min(1).max(253)).max(50) })
  .refine((p) => p.policy !== "domains" || p.domains.length > 0, { message: "Allowed domains needs at least one domain", path: ["domains"] })
  .openapi("SignupPolicy");
const Account = z
  .object({ userId: z.uuid(), email: z.string(), emailVerified: z.boolean(), createdAt: z.iso.datetime(), serverAdmin: z.boolean() })
  .openapi("Account");

const policyRoute = createRoute({ method: "get", path: "/api/server/policy", responses: { 200: json(Policy, "Who may sign up"), ...errors } });
const setPolicyRoute = createRoute({
  method: "put",
  path: "/api/server/policy",
  request: { body: { content: { "application/json": { schema: Policy } } } },
  responses: { 200: json(Policy, "The policy now in force"), ...errors },
});
const mailRoute = createRoute({
  method: "get",
  path: "/api/server/mail-status",
  responses: { 200: json(z.object({ ok: z.boolean() }).openapi("MailStatus"), "Whether this server can send mail now"), ...errors },
});
const accountsRoute = createRoute({
  method: "get",
  path: "/api/server/accounts",
  responses: { 200: json(z.object({ accounts: z.array(Account) }), "Every account on this server, oldest first"), ...errors },
});
const addAdminRoute = createRoute({
  method: "post",
  path: "/api/server/admins",
  request: { body: { content: { "application/json": { schema: z.object({ email: z.string().trim().min(3).max(320) }) } } } },
  responses: { 200: json(Ok, "The account is a Server admin"), ...errors },
});
const removeAdminRoute = createRoute({
  method: "delete",
  path: "/api/server/admins/{userId}",
  request: { params: z.object({ userId: z.uuid() }) },
  responses: { 200: json(Ok, "The account is no longer a Server admin"), ...errors },
});

const STATUS = { forbidden: 403, step_up_required: 403, bad_domain: 400, no_account: 404, not_found: 404, mail_failing: 409, last_server_admin: 409 } as const;

export function serverRoutes(auth: () => Auth, mailer: () => Mailer, admission: () => Admission) {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    },
  });
  const serverAdmin = requireServerAdmin(auth);
  for (const p of ["/api/server/policy", "/api/server/mail-status", "/api/server/accounts", "/api/server/admins", "/api/server/admins/*"]) app.use(p, serverAdmin);

  const mailOk = async () => (await mailer().verify?.()) ?? true;
  // Every reason the functions return is a key of STATUS.
  const status = (reason: string) => STATUS[reason as keyof typeof STATUS];
  const steppedUp = adminSteppedUp;

  return app
    .openapi(policyRoute, async (c) => {
      const { policy, domains } = await admission().status();
      return c.json({ policy, domains }, 200);
    })
    .openapi(setPolicyRoute, async (c) => {
      // Every policy needs mail to confirm addresses, so none changes while mail fails (spec, Decided 1).
      if (!(await mailOk())) return c.json({ error: "mail_failing" }, status("mail_failing"));
      const { policy, domains } = c.req.valid("json");
      const refused = await setSignupPolicy(c.get("admin").userId, policy, policy === "domains" ? domains : []);
      if (refused) return c.json({ error: refused }, status(refused));
      const now = await admission().status();
      return c.json({ policy: now.policy, domains: now.domains }, 200);
    })
    .openapi(mailRoute, async (c) => c.json({ ok: await mailOk() }, 200))
    .openapi(accountsRoute, async (c) => {
      const accounts = await listAccounts(c.get("admin").userId);
      return accounts ? c.json({ accounts }, 200) : c.json({ error: "forbidden" }, status("forbidden"));
    })
    .openapi(addAdminRoute, async (c) => {
      if (!steppedUp(c.get("admin"))) return c.json({ error: "step_up_required" }, status("step_up_required"));
      const refused = await addServerAdmin(c.get("admin").userId, c.req.valid("json").email);
      return refused ? c.json({ error: refused }, status(refused)) : c.json({ ok: true as const }, 200);
    })
    .openapi(removeAdminRoute, async (c) => {
      if (!steppedUp(c.get("admin"))) return c.json({ error: "step_up_required" }, status("step_up_required"));
      const refused = await removeServerAdmin(c.get("admin").userId, c.req.valid("param").userId);
      return refused ? c.json({ error: refused }, status(refused)) : c.json({ ok: true as const }, 200);
    });
}
