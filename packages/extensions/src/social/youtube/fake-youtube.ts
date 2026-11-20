// SPDX-License-Identifier: AGPL-3.0-only
// Test only: YouTube's channels.list over real HTTP, from the YouTube Data API's reference and errors
// pages. It implements just the call the plugin makes, and records each one.

export type FakeYouTubeCall = { path: string; auth: string | null };

/** A channel as `channels.list?part=snippet` returns it. */
export const youtubeChannel = (id: string, title: string) => ({ kind: "youtube#channel", etag: "e", id, snippet: { title, description: "", customUrl: "@acme", publishedAt: "2020-01-01T00:00:00Z" } });

/** Google's error body, with the reason the YouTube errors page names. */
export const youtubeError = (code: number, reason: string) => Response.json({ error: { code, message: reason, errors: [{ message: reason, domain: "youtube.header", reason }] } }, { status: code });

export function fakeYouTube() {
  const calls: FakeYouTubeCall[] = [];
  /** What channels.list answers. Tests replace it. */
  let answer = (): Response => Response.json({ kind: "youtube#channelListResponse", pageInfo: { totalResults: 1, resultsPerPage: 5 }, items: [youtubeChannel("UC1", "Acme")] });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req): Response {
      const u = new URL(req.url);
      calls.push({ path: u.pathname + u.search, auth: req.headers.get("authorization") });
      if (u.pathname === "/youtube/v3/channels") return answer();
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
