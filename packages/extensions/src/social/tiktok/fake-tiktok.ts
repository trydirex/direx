// SPDX-License-Identifier: AGPL-3.0-only
// Test only: TikTok's user info call over real HTTP, from the Get User Info and error handling pages.
// It implements just the call the plugin makes, and records each one.

export type FakeTikTokCall = { path: string; auth: string | null };

/** TikTok's v2 error body, which comes back even on success with code "ok". */
export const tiktokError = (status: number, code: string) => Response.json({ error: { code, message: code, log_id: "202611200000000000" } }, { status });

export function fakeTikTok() {
  const calls: FakeTikTokCall[] = [];
  /** What user info answers. Tests replace it. */
  let answer = (): Response => Response.json({ data: { user: { open_id: "723f24d7-e717-40f8-a2b6-cb8464cd23b4", display_name: "Acme" } }, error: { code: "ok", message: "", log_id: "202611200000000000" } });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req): Response {
      const u = new URL(req.url);
      calls.push({ path: u.pathname + u.search, auth: req.headers.get("authorization") });
      if (u.pathname === "/v2/user/info/") return answer();
      return new Response("not in the fake", { status: 418 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    answer: (a: () => Response) => {
      answer = a;
    },
    stop: () => server.stop(true),
  };
}
