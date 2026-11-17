// SPDX-License-Identifier: AGPL-3.0-only
// Test only: Threads' container, status and publish calls over real HTTP, from Threads' publishing docs.
// Like Threads, it fetches a video container's file from the link it was given. It implements just the
// calls the plugin makes, and records each one.

export type FakeThreadsCall = { method: string; path: string; form: Record<string, string> };

export function fakeThreads() {
  const calls: FakeThreadsCall[] = [];
  /** What each status check reports, in turn, then FINISHED. */
  const processing: string[] = [];
  /** How many bytes the fake read from each video link it was given. */
  const fetched: number[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      const form = Object.fromEntries(new URLSearchParams(await req.text()));
      calls.push({ method: req.method, path: u.pathname + u.search, form });
      if (u.pathname.endsWith("/threads")) {
        if (form.video_url) fetched.push((await (await fetch(form.video_url)).arrayBuffer()).byteLength);
        return Response.json({ id: "c1" });
      }
      if (u.pathname === "/c1") {
        const status = processing.shift() ?? "FINISHED";
        return Response.json({ id: "c1", status, ...(status === "ERROR" && { error_message: "Video duration too long" }) });
      }
      if (u.pathname.endsWith("/threads_publish")) return Response.json({ id: "m1" });
      if (u.pathname === "/m1") return Response.json({ permalink: "https://www.threads.com/@ana/post/abc" });
      return new Response("not in the fake", { status: 418 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    processing,
    fetched,
    paths: () => calls.map((c) => c.path.split("?")[0]!),
    reset: () => {
      calls.length = 0;
      processing.length = 0;
      fetched.length = 0;
    },
    stop: () => server.stop(true),
  };
}
