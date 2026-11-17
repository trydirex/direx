// SPDX-License-Identifier: AGPL-3.0-only
// ffprobe, ffmpeg and whisper-cli, each run in the sandbox with no network. A run sees its own work
// directory and the files handed to it read-only, nothing else. Arguments are built here from ids and
// numbers only, never from anything a person typed.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runSandboxed } from "../../models/index";
import { captionsAss } from "../domain/captions";
import { wordsFromWhisper, type Word } from "../domain/transcript";

export type Tools = { ffmpeg: string; ffprobe: string; whisper: string };
export type Probe = { durationMs: number; hasVideo: boolean; hasAudio: boolean };

/** The three binaries, or what's missing. The image ships all three; a dev machine may not. */
export function findTools(which: (bin: string) => string | null = Bun.which): Tools | { missing: string[] } {
  const found = { ffmpeg: which("ffmpeg"), ffprobe: which("ffprobe"), whisper: which("whisper-cli") };
  const missing = Object.entries(found).filter(([, v]) => !v).map(([k]) => (k === "whisper" ? "whisper-cli" : k));
  return missing.length ? { missing } : (found as Tools);
}

/** The tool ran and refused. `detail` is the end of what it wrote, which never holds a secret. */
export class ToolFailed extends Error {
  constructor(
    readonly tool: string,
    readonly detail: string,
  ) {
    super(`${tool} failed: ${detail}`);
  }
}

/** libass looks fonts up through fontconfig, which has no config inside the sandbox until this. */
const FONTS_CONF = `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/usr/share/fonts/truetype/dejavu</dir><cachedir>/tmp/fontconfig</cachedir></fontconfig>`;

type Run = { binary: string; args: string[]; work: string; inputs?: Record<string, string>; signal: AbortSignal; env?: Record<string, string> };

async function run(tool: string, r: Run): Promise<string> {
  const out = await runSandboxed({ binary: r.binary, args: r.args, env: r.env ?? {}, stdin: "", egress: [], work: { dir: r.work, inputs: r.inputs ?? {} }, signal: r.signal });
  if (!out.ran) throw new ToolFailed(tool, out.reason);
  if (out.exitCode !== 0) throw new ToolFailed(tool, out.stderr.trim().slice(-500) || `exit code ${out.exitCode}`);
  return out.stdout;
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

/** How long the file is and whether it has picture and sound, read by ffprobe. */
export async function probe(t: Tools, work: string, source: string, signal: AbortSignal): Promise<Probe> {
  const out = await run("ffprobe", { binary: t.ffprobe, args: ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "/in/source"], work, inputs: { source }, signal });
  const j = JSON.parse(out) as { format?: { duration?: string }; streams?: { codec_type?: string }[] };
  const duration = Number(j.format?.duration);
  const kinds = new Set((j.streams ?? []).map((s) => s.codec_type));
  return { durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : 0, hasVideo: kinds.has("video"), hasAudio: kinds.has("audio") };
}

/** whisper reads 16 kHz mono 16-bit WAV, written to /work/audio.wav. */
export async function toWav(t: Tools, work: string, source: string, signal: AbortSignal): Promise<void> {
  await run("ffmpeg", { binary: t.ffmpeg, args: ["-loglevel", "error", "-nostdin", "-y", "-i", "/in/source", "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "audio.wav"], work, inputs: { source }, signal });
}

/** [DEFAULT] whisper's threads: four use a typical small server without starving the rest. */
export const WHISPER_THREADS = 4;

/** Words with times for /work/audio.wav. The language is detected, so a German recording stays German. */
export async function transcribe(t: Tools, work: string, model: string, signal: AbortSignal): Promise<Word[]> {
  await run("whisper-cli", {
    binary: t.whisper,
    args: ["-m", "/in/model.bin", "-f", "/work/audio.wav", "-l", "auto", "-ml", "1", "-sow", "-oj", "-of", "/work/transcript", "-t", String(WHISPER_THREADS), "-np"],
    work,
    inputs: { "model.bin": model },
    signal,
  });
  return wordsFromWhisper(JSON.parse(await readFile(join(work, "transcript.json"), "utf8")));
}

/**
 * One clip: cut at the asked times, center-cropped to 9:16, 1080x1920, captions burned in, encoded so
 * every network that takes video takes it. `-ss` before `-i` seeks fast and, since it re-encodes, cuts
 * on the asked frame. The words are timed from the clip's start.
 */
export async function cut(t: Tools, work: string, source: string, clip: { startMs: number; endMs: number; words: readonly Word[]; out: string }, signal: AbortSignal): Promise<void> {
  if (!/^[a-z0-9-]+\.mp4$/.test(clip.out)) throw new Error("clips: an output name is an id and .mp4");
  await writeFile(join(work, "captions.ass"), captionsAss(clip.words));
  await writeFile(join(work, "fonts.conf"), FONTS_CONF);
  const filter = "crop=ih*9/16:ih,scale=1080:1920,setsar=1,subtitles=captions.ass:fontsdir=/usr/share/fonts/truetype/dejavu";
  await run("ffmpeg", {
    binary: t.ffmpeg,
    args: [
      "-loglevel", "error", "-nostdin", "-y",
      "-ss", seconds(clip.startMs), "-i", "/in/source", "-t", seconds(clip.endMs - clip.startMs),
      "-vf", filter,
      "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", "30", "-g", "60", "-crf", "20", "-preset", "medium",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart", clip.out,
    ],
    work,
    inputs: { source },
    env: { FONTCONFIG_FILE: "/work/fonts.conf" },
    signal,
  });
}

/** whisper.cpp's quantized multilingual base model, pinned to one commit and its hash. MIT licensed. */
export const WHISPER_MODEL = {
  name: "ggml-base-q5_1.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q5_1.bin",
  sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
  bytes: 59_707_625,
} as const;

export class ModelUnavailable extends Error {}

/**
 * The speech model's path, downloading it the first time. Written beside its final name and renamed
 * only once its hash matches, so a cut-off download is never used. Runs outside the sandbox: it is the
 * one network call clipping makes besides the agent's.
 */
export async function ensureModel(dir: string, fetchFn: typeof fetch = fetch, model: { name: string; url: string; sha256: string; bytes: number } = WHISPER_MODEL): Promise<string> {
  const path = join(dir, model.name);
  if (existsSync(path)) return path;
  await mkdir(dir, { recursive: true });
  const part = `${path}.part`;
  try {
    const res = await fetchFn(model.url);
    if (!res.ok || !res.body) throw new ModelUnavailable(`the download answered ${res.status}`);
    const hash = createHash("sha256");
    const file = Bun.file(part).writer();
    let bytes = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > model.bytes) throw new ModelUnavailable("the download is larger than the pinned model");
      hash.update(chunk);
      file.write(chunk);
    }
    await file.end();
    if (bytes !== model.bytes || hash.digest("hex") !== model.sha256) throw new ModelUnavailable("the download doesn't match the pinned model");
    await rename(part, path);
    return path;
  } catch (e) {
    await rm(part, { force: true });
    throw e instanceof ModelUnavailable ? e : new ModelUnavailable((e as Error).message);
  }
}
