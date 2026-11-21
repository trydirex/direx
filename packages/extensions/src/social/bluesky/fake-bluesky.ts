// SPDX-License-Identifier: AGPL-3.0-only
// Test only: a Bluesky account server and its video service over real HTTP, from Bluesky's video upload
// guide. It implements just the calls the plugin makes, and records each one.

export type FakeBlueskyCall = { method: string; path: string; body: string; bytes: number; auth: string | null };

export function fakeBluesky() {
  const calls: FakeBlueskyCall[] = [];
  /** What each job status check reports, in turn, then completed. */
  const processing: string[] = [];
  /** The account's feed on the public AppView, newest first. getPosts finds its posts by uri. */
  const feed: { post: { uri: string }; reason?: unknown }[] = [];
  /** Answers the next calls take instead, in turn: a 429, say. */
  const failNext: Response[] = [];
  const blob = { $type: "blob", ref: { $link: "bafyvideo" }, mimeType: "video/mp4", size: 1 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      const raw = new Uint8Array(await req.arrayBuffer());
      const video = u.pathname.endsWith("uploadVideo") || u.pathname.endsWith("uploadBlob");
      calls.push({ method: req.method, path: u.pathname + u.search, body: video ? "" : new TextDecoder().decode(raw), bytes: raw.length, auth: req.headers.get("authorization") });
      if (failNext.length) return failNext.shift()!;
      if (u.pathname.endsWith("getAuthorFeed")) {
        const from = Number(u.searchParams.get("cursor") ?? 0);
        const to = from + Number(u.searchParams.get("limit"));
        return Response.json({ feed: feed.slice(from, to), ...(to < feed.length && { cursor: String(to) }) });
      }
      if (u.pathname.endsWith("getPosts")) return Response.json({ posts: feed.filter((f) => !f.reason && u.searchParams.getAll("uris").includes(f.post.uri)).map((f) => f.post) });
      if (u.pathname.endsWith("createSession")) return Response.json({ did: "did:plc:ana", handle: "ana.bsky.social", accessJwt: "jwt", didDoc: { service: [{ id: "#atproto_pds", serviceEndpoint: "https://pds.example" }] } });
      if (u.pathname.endsWith("getServiceAuth")) return Response.json({ token: "service-token" });
      if (u.pathname.endsWith("uploadBlob")) return Response.json({ blob: { $type: "blob", ref: { $link: `bafy${raw.length}` }, mimeType: req.headers.get("content-type"), size: raw.length } });
      if (video) return Response.json({ jobId: "J1", did: "did:plc:ana", state: "JOB_STATE_CREATED" });
      if (u.pathname.endsWith("getJobStatus")) {
        const state = processing.shift() ?? "JOB_STATE_COMPLETED";
        return Response.json({ jobStatus: { jobId: "J1", state, ...(state === "JOB_STATE_COMPLETED" && { blob }), ...(state === "JOB_STATE_FAILED" && { error: "unsupported codec" }) } });
      }
      if (u.pathname.endsWith("createRecord")) return Response.json({ uri: "at://did:plc:ana/app.bsky.feed.post/r1", cid: "c1" });
      return new Response("not in the fake", { status: 418 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    blob,
    calls,
    feed,
    failNext,
    processing,
    paths: () => calls.map((c) => c.path.split("?")[0]!),
    reset: () => {
      calls.length = 0;
      processing.length = 0;
      feed.length = 0;
      failNext.length = 0;
    },
    stop: () => server.stop(true),
  };
}
