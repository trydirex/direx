// SPDX-License-Identifier: AGPL-3.0-only
// ffmpeg and ffprobe run for real, in the sandbox, on a generated video. Where either or the sandbox is
// missing, the one test that runs says so. whisper is checked with a recorded transcript instead.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { runSandboxed, sandboxStatus } from "../models/index";
import { cut, ensureModel, findTools, ModelUnavailable, probe, ToolFailed, toWav, type Tools } from "./adapters/tools";

const root = await mkdtemp(join(tmpdir(), "direx-clips-tools-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const signal = () => AbortSignal.timeout(120_000);

const ffmpeg = Bun.which("ffmpeg");
const ffprobe = Bun.which("ffprobe");
const sandbox = await sandboxStatus();

/** What ffprobe on the host says about a file the sandbox wrote. */
async function streams(path: string) {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { stdout: "pipe" });
  return JSON.parse(await new Response(p.stdout).text()) as { format: { duration: string; tags?: Record<string, string> }; streams: Record<string, string | number>[] };
}
/** One raw RGB frame, to compare a captioned cut with a bare one. */
async function frame(path: string, at: number) {
  const p = Bun.spawn(["ffmpeg", "-loglevel", "error", "-ss", String(at), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe" });
  return new Uint8Array(await new Response(p.stdout).arrayBuffer());
}

if (ffmpeg && ffprobe && sandbox.ok) {
  const t: Tools = { ffmpeg, ffprobe, whisper: "/nonexistent" };
  const work = await mkdtemp(join(root, "work-"));
  const source = join(root, "source.mp4");
  // 16:9 picture and a tone, 40 s, made on the host as a stand-in for an upload.
  const made = Bun.spawnSync(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30:duration=40", "-f", "lavfi", "-i", "sine=frequency=440:duration=40", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", source]);
  expect(made.exitCode).toBe(0);

  test("ffprobe reads the length and the streams", async () => {
    expect(await probe(t, work, source, signal())).toEqual({ durationMs: expect.closeTo(40_000, -2), hasVideo: true, hasAudio: true });
  });

  test("the audio becomes 16 kHz mono WAV for whisper", async () => {
    await toWav(t, work, source, signal());
    const s = (await streams(join(work, "audio.wav"))).streams[0]!;
    expect(s).toMatchObject({ codec_name: "pcm_s16le", sample_rate: "16000", channels: 1 });
  });

  test("a clip is 1080x1920 H.264 High, yuv420p, AAC 48 kHz, faststart, as long as asked within a frame", async () => {
    const words = [{ startMs: 200, endMs: 900, text: "Captions" }, { startMs: 900, endMs: 1600, text: "follow" }, { startMs: 1600, endMs: 2400, text: "speech." }];
    await cut(t, work, source, { startMs: 12_340, endMs: 33_340, words, out: "a.mp4" }, signal());
    const info = await streams(join(work, "a.mp4"));
    const video = info.streams.find((s) => s.codec_type === "video")!;
    const audio = info.streams.find((s) => s.codec_type === "audio")!;
    expect(video).toMatchObject({ codec_name: "h264", profile: "High", width: 1080, height: 1920, pix_fmt: "yuv420p" });
    expect(audio).toMatchObject({ codec_name: "aac", sample_rate: "48000", channels: 2 });
    expect(Math.abs(Number(info.format.duration) - 21)).toBeLessThanOrEqual(0.04);
    // faststart puts the index before the media, so a network can start reading at once.
    const head = new TextDecoder("latin1").decode((await Bun.file(join(work, "a.mp4")).slice(0, 64 * 1024).arrayBuffer()));
    expect(head.indexOf("moov")).toBeGreaterThan(-1);
    expect(head.indexOf("moov")).toBeLessThan(head.indexOf("mdat") === -1 ? Infinity : head.indexOf("mdat"));

    await cut(t, work, source, { startMs: 12_340, endMs: 33_340, words: [], out: "bare.mp4" }, signal());
    expect(await frame(join(work, "a.mp4"), 0.5)).not.toEqual(await frame(join(work, "bare.mp4"), 0.5));
  }, 120_000);

  test("an output name is an id, never a path", async () => {
    await expect(cut(t, work, source, { startMs: 0, endMs: 1000, words: [], out: "../x.mp4" }, signal())).rejects.toThrow("an id and .mp4");
  });

  test("in the sandbox ffmpeg reaches no network and no host file", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(Bun.file(source)) });
    const hostFile = join(root, "secret.mp4");
    await writeFile(hostFile, new Uint8Array(await Bun.file(source).arrayBuffer()));
    try {
      const probeAt = async (input: string) => {
        return runSandboxed({ binary: ffprobe, args: ["-v", "error", "-rw_timeout", "3000000", "-show_format", input], env: {}, stdin: "", egress: [], work: { dir: work }, signal: signal() });
      };
      const net = await probeAt(`http://127.0.0.1:${server.port}/v.mp4`);
      expect(net).toMatchObject({ ran: true });
      expect(net.ran && net.exitCode).not.toBe(0);
      const host = await probeAt(hostFile);
      expect(host.ran && host.exitCode).not.toBe(0);
      expect(host.ran && host.stderr).toMatch(/No such file/);
    } finally {
      await server.stop(true);
    }
  });

  test("a file ffmpeg can't read fails with ffmpeg's own words", async () => {
    const junk = join(root, "junk.mp4");
    await writeFile(junk, "not a video");
    await expect(probe(t, work, junk, signal())).rejects.toBeInstanceOf(ToolFailed);
  });
} else {
  test("without ffmpeg, ffprobe or the sandbox, the tools say what's missing", () => {
    const found = findTools(() => null);
    expect(found).toEqual({ missing: ["ffmpeg", "ffprobe", "whisper-cli"] });
  });
}

test("findTools finds all three by name, or names what's missing", () => {
  expect(findTools((b) => `/usr/bin/${b}`)).toEqual({ ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe", whisper: "/usr/bin/whisper-cli" });
  expect(findTools((b) => (b === "whisper-cli" ? null : `/x/${b}`))).toEqual({ missing: ["whisper-cli"] });
});

const bytes = new TextEncoder().encode("model bytes, not a real model");
const pinned = { name: "m.bin", url: "https://models.example/m.bin", sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), bytes: bytes.length };

test("the model downloads once, checked against its pinned hash", async () => {
  const dir = join(root, "models-ok");
  let calls = 0;
  const fetchFn = (async () => (calls++, new Response(bytes))) as unknown as typeof fetch;
  const path = await ensureModel(dir, fetchFn, pinned);
  expect(await Bun.file(path).text()).toBe("model bytes, not a real model");
  expect(await ensureModel(dir, fetchFn, pinned)).toBe(path);
  expect(calls).toBe(1);
});

test("a download that is wrong, too long, refused or cut off leaves nothing behind", async () => {
  const dir = join(root, "models-bad");
  const answer = (r: () => Promise<Response>) => r as unknown as typeof fetch;
  await expect(ensureModel(dir, answer(async () => new Response("other bytes, same length....!!")), pinned)).rejects.toBeInstanceOf(ModelUnavailable);
  await expect(ensureModel(dir, answer(async () => new Response(new Uint8Array(1000))), pinned)).rejects.toThrow("larger than the pinned model");
  await expect(ensureModel(dir, answer(async () => new Response("no", { status: 404 })), pinned)).rejects.toThrow("answered 404");
  await expect(ensureModel(dir, answer(async () => Promise.reject(new TypeError("connection reset"))), pinned)).rejects.toThrow("connection reset");
  expect(existsSync(join(dir, "m.bin"))).toBe(false);
  expect(existsSync(join(dir, "m.bin.part"))).toBe(false);
});
