// SPDX-License-Identifier: AGPL-3.0-only
// Bun's body cap is 2 GB for video uploads, so the app holds every other route to 1 MB.
import { expect, test } from "vitest";
import { app, BODY_MAX_BYTES } from "./main";

const post = (path: string, bytes: number, declared = true) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(declared && { "content-length": String(bytes) }) },
    body: "x".repeat(bytes),
  });

test("a body over the cap is refused before sign-in reads it, declared or not", async () => {
  for (const declared of [true, false]) {
    const res = await post("/api/auth/sign-in/email", BODY_MAX_BYTES + 1, declared);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
  }
});

test("the two uploads are left to their own caps", async () => {
  for (const path of [`/api/w/${crypto.randomUUID()}/media?kind=source`, "/api/server/plugins/review"]) {
    expect((await post(path, BODY_MAX_BYTES + 1)).status).not.toBe(413);
  }
});
