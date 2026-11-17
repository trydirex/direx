// SPDX-License-Identifier: AGPL-3.0-only
// Test only: X's v2 media upload and post calls over real HTTP, from X's media upload and posts docs.
// It implements just the calls the plugin makes, and records each one.

export type FakeXCall = { method: string; path: string; body: string; bytes: number };

export function fakeX() {
  const calls: FakeXCall[] = [];
  /** What each status check reports, in turn, then succeeded. FINALIZE reports the first. */
  const processing: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      const path = u.pathname + u.search;
      if (u.pathname.endsWith("/append")) {
        const form = await req.formData();
        const media = form.get("media") as File;
        calls.push({ method: req.method, path, body: `segment_index=${String(form.get("segment_index"))}`, bytes: media.size });
        return new Response(null, { status: 204 });
      }
      const body = await req.text();
      calls.push({ method: req.method, path, body, bytes: body.length });
      const info = () => {
        const state = processing.shift() ?? "succeeded";
        return { state, ...(state === "failed" && { error: { message: "InvalidMedia" } }) };
      };
      if (path === "/2/media/upload/initialize") return Response.json({ data: { id: "M1", media_key: "7_M1" } });
      if (u.pathname.endsWith("/finalize")) return Response.json({ data: { id: "M1", processing_info: info() } });
      if (u.pathname === "/2/media/upload" && u.searchParams.get("command") === "STATUS") return Response.json({ data: { id: "M1", processing_info: info() } });
      if (path === "/2/tweets") return Response.json({ data: { id: "T1", text: "" } }, { status: 201 });
      return new Response("not in the fake", { status: 418 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    processing,
    paths: () => calls.map((c) => c.path),
    reset: () => {
      calls.length = 0;
      processing.length = 0;
    },
    stop: () => server.stop(true),
  };
}
