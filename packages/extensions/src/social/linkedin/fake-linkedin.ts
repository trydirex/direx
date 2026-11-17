// SPDX-License-Identifier: AGPL-3.0-only
// Test only: LinkedIn's video and image uploads and post calls over real HTTP, from LinkedIn's Videos,
// Images and Posts API docs. It implements just the calls the plugin makes, and records each one.

export type FakeLinkedInCall = { method: string; path: string; body: string; bytes: number };

const MiB = 1024 * 1024;

export function fakeLinkedIn() {
  const calls: FakeLinkedInCall[] = [];
  /** What each status check answers, in turn, then AVAILABLE. */
  const processing: string[] = [];
  let images = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      const raw = new Uint8Array(await req.arrayBuffer());
      const upload = u.pathname.startsWith("/upload/");
      const call = { method: req.method, path: u.pathname + u.search, body: upload ? "" : new TextDecoder().decode(raw), bytes: raw.length };
      calls.push(call);
      if (call.path === "/rest/videos?action=initializeUpload") {
        const size = (JSON.parse(call.body) as { initializeUploadRequest: { fileSizeBytes: number } }).initializeUploadRequest.fileSizeBytes;
        const uploadInstructions = Array.from({ length: Math.ceil(size / (4 * MiB)) }, (_, i) => ({ uploadUrl: `${url}/upload/${i}`, firstByte: i * 4 * MiB, lastByte: Math.min(size, (i + 1) * 4 * MiB) - 1 }));
        return Response.json({ value: { video: "urn:li:video:V1", uploadToken: "", uploadInstructions } });
      }
      if (call.path === "/rest/images?action=initializeUpload") {
        images += 1;
        return Response.json({ value: { uploadUrlExpiresAt: 0, uploadUrl: `${url}/upload/image-${images}`, image: `urn:li:image:I${images}` } });
      }
      if (upload) return new Response(null, { status: u.pathname.includes("image") ? 201 : 200, headers: { etag: `e${u.pathname.split("/")[2]}` } });
      if (call.path === "/rest/videos?action=finalizeUpload") return new Response(null);
      if (u.pathname.startsWith("/rest/videos/")) return Response.json({ status: processing.shift() ?? "AVAILABLE", processingFailureReason: "bad codec" });
      if (call.path === "/rest/posts") return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7" } });
      return new Response("not in the fake", { status: 418 });
    },
  });
  const url: string = `http://127.0.0.1:${server.port}`;
  return {
    url,
    calls,
    processing,
    /** Calls with each upload part's number dropped, for comparing the sequence. */
    paths: () => calls.map((c) => c.path.replace(/\/upload\/\d+/, "/upload")),
    reset: () => {
      calls.length = 0;
      processing.length = 0;
      images = 0;
    },
    stop: () => server.stop(true),
  };
}
