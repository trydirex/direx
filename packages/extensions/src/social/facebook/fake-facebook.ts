// SPDX-License-Identifier: AGPL-3.0-only
// Test only: Facebook's Page token, Reels upload and status calls over real HTTP, from Meta's Reels
// Publishing API docs. It implements just the calls the plugin makes, and records each one.

export type FakeFacebookCall = { method: string; path: string; body: string; bytes: number; offset: string | null };

export function fakeFacebook() {
  const calls: FakeFacebookCall[] = [];
  /** What each status check reports for publishing, in turn, then complete. "error" fails processing. */
  const processing: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      const raw = new Uint8Array(await req.arrayBuffer());
      const upload = u.pathname.startsWith("/rupload/");
      calls.push({ method: req.method, path: u.pathname + u.search, body: upload ? "" : new TextDecoder().decode(raw), bytes: raw.length, offset: req.headers.get("offset") });
      if (u.pathname === "/me/accounts") return Response.json({ data: [{ id: "P1", access_token: "page-token" }] });
      if (u.pathname === "/P1/video_reels") {
        const phase = new URLSearchParams(new TextDecoder().decode(raw)).get("upload_phase");
        return phase === "start" ? Response.json({ video_id: "V1", upload_url: `${url}/rupload/V1` }) : Response.json({ success: true });
      }
      if (upload) return Response.json({ success: true });
      if (u.pathname === "/V1") {
        const p = processing.shift() ?? "complete";
        const status = p === "error" ? { video_status: "error", processing_phase: { status: "error", errors: [{ message: "Video too long" }] } } : { video_status: p === "complete" ? "ready" : "processing", publishing_phase: { status: p } };
        return Response.json({ status, id: "V1" });
      }
      return new Response("not in the fake", { status: 418 });
    },
  });
  const url: string = `http://127.0.0.1:${server.port}`;
  return {
    url,
    calls,
    processing,
    paths: () => calls.map((c) => c.path.split("?")[0]!),
    reset: () => {
      calls.length = 0;
      processing.length = 0;
    },
    stop: () => server.stop(true),
  };
}
