// SPDX-License-Identifier: AGPL-3.0-only
// Exercise HTTP validation with an isolated list service; no database or session service needed.
import { expect, test, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { MemberEnv } from "../identity/index";
import type { Items } from "./application/create";
import { itemRoutes } from "./routes";
import { TYPES } from "../../../../web/src/items/type-labels";

test("every offered type fits the bounded API filter; other limits remain enforced", async () => {
  const list = vi.fn().mockResolvedValue({ items: [], needsYouCount: 0, nextCursor: null });
  const app = new OpenAPIHono<MemberEnv>();
  const workspaceId = "00000000-0000-4000-8000-0000000000aa";
  app.use("*", async (c, next) => {
    c.set("member", { workspaceId, workspaceName: "Test", userId: "test", email: "test@example.com", role: "owner", signedInAt: new Date() });
    await next();
  });
  app.route("/", itemRoutes({ items: () => ({ list }) as unknown as Items }));
  const get = (query: string) => app.request(`/api/w/${workspaceId}/items?${query}`);
  const keys = TYPES.flatMap(([, keys]) => keys);
  expect(keys.length).toBeGreaterThan(20);
  expect((await get(`type=${keys.join(",")}`)).status).toBe(200);
  expect(list).toHaveBeenLastCalledWith(workspaceId, expect.objectContaining({ types: keys }));
  expect((await get(`type=${Array(32).fill("outreach").join(",")}`)).status).toBe(200);
  expect((await get(`type=${Array(33).fill("outreach").join(",")}`)).status).toBe(400);
  expect((await get(`channel=${Array(21).fill("email").join(",")}`)).status).toBe(400);
  expect((await get(`state=${Array(21).fill("sent").join(",")}`)).status).toBe(400);
  expect((await get(`q=${"x".repeat(100)}`)).status).toBe(200);
  expect((await get(`q=${"x".repeat(101)}`)).status).toBe(400);
});
