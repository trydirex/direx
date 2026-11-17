// SPDX-License-Identifier: AGPL-3.0-only
// What publishing a post means on every network: what is approved, what counts as a link, how a refusal
// reads and how follow-ups run. Each plugin adds only its own count, wire format and error table.
import { effectSchemas, type ExecuteResult, type FollowUpResult, type MediaRef } from "@direx/plugin-sdk";
import { z } from "zod";

export type Refused = Extract<ExecuteResult, { kind: "refused" }>;
const refused = (retryable: boolean, detail: string): Refused => ({ kind: "refused", permanent: false, retryable, detail });
/** Waits for a person, who can edit the post or look into why. */
export const held = (detail: string) => refused(false, detail);
export const later = (detail: string) => refused(true, detail);
/** The network asked this account to slow down. The host pauses the account as well as retrying. */
export const rateLimited = (detail: string): Refused => ({ ...later(detail), providerLimit: "sending_limit" });
/** The network blocked the post under its spam or abuse rules. Waits for a person, and pauses the account. */
export const policyBlocked = (detail: string): Refused => ({ ...held(detail), providerLimit: "abuse" });
/** The retry meets the host's credential check, which holds it until a reconnect. */
export const tokenRejected = (detail: string): Refused => ({ ...refused(true, detail), credentialRejected: true });
export const notConnected = () => held("account not connected");
export const notAPost = (): Refused => ({ kind: "refused", permanent: true, retryable: false, detail: "the approved spec is not a post" });
export const isRefused = (r: object): r is Refused => "kind" in r && r.kind === "refused";

// The post a person approves, as the SDK catalogue describes it (ADR 0028 rule 001); this parse drops any
// other field, as it always has.
const spec = z.object(effectSchemas("social.publish").spec.shape);
export type PostSpec = z.infer<typeof spec>;
export const postSpec = (s: unknown): PostSpec | null => spec.safeParse(s).data ?? null;
const input = spec.extend({ links: z.boolean() });

const URL_END = /[.,;:!?'’”]+$/;
// ponytail: any two-letter ending counts as a domain, so "Node.js" counts as a link. Erring this way only costs a word the person sees removed.
const LINK = /https?:\/\/[^\s<>"]+|(?<![\p{L}\p{N}_@./-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}(?::\d+)?(?:[/?#][^\s<>"]*)?(?![\p{L}\p{N}_@-])/giu;

function trimUrl(url: string): string {
  const t = url.replace(URL_END, "");
  const unbalanced = t.endsWith(")") && t.split("(").length < t.split(")").length;
  const out = unbalanced ? t.slice(0, -1) : t;
  return out === url ? url : trimUrl(out);
}

export function findLinks(text: string): { start: number; end: number; url: string }[] {
  return [...text.matchAll(LINK)].map((m) => {
    const url = trimUrl(m[0]);
    return { start: m.index, end: m.index + url.length, url };
  });
}

/** Text with no links comes back untouched, so a removal is always something the person can see. */
export function removeLinks(text: string): string {
  const links = findLinks(text);
  if (!links.length) return text;
  const bare = links.reduceRight((t, l) => t.slice(0, l.start) + t.slice(l.end), text);
  return bare
    .replace(/\( *\)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ +([.,;:!?)])/g, "$1")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (text: string) => [...segmenter.segment(text)].map((s) => s.segment);
export const isEmoji = (grapheme: string) => /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(grapheme);

export type PostRules = {
  needsTarget?: boolean;
  /** How many follow-ups fit. Zero where the network doesn't offer them here. */
  maxFollowUps: number;
  /** Absent where the network documents no limit, so the network itself refuses. */
  count?: (text: string) => { used: number; limit: number };
  /** Any other reason this text can't go, in the same words a person sees for a count. */
  refuse?: (text: string) => string | undefined;
  /** What video the network takes here, as far as Direx can tell without reading the file. Absent: none. */
  video?: VideoRules;
  /** What images the network takes here, and how many. Absent: none, so a post with images is refused. */
  image?: ImageRules;
};

export type ImageRules = { network: string; types: readonly string[]; maxBytes: number; max: number };
const isImage = (ref: MediaRef) => ref.contentType.startsWith("image/");

/** Why these images can't go on this network, in a person's words, or undefined when they can. */
export function refuseImages(refs: readonly MediaRef[], rules: ImageRules | undefined): string | undefined {
  if (!rules) return "this network takes no images here";
  if (refs.length > rules.max) return `${rules.network} takes up to ${rules.max} ${rules.max === 1 ? "image" : "images"} a post here; this has ${refs.length}`;
  const takes = `${rules.network} takes ${rules.types.map((t) => TYPE_NAMES[t] ?? t).join(", ")} images up to ${(rules.maxBytes / MB).toLocaleString("en", { maximumFractionDigits: 1 })} MB`;
  for (const [i, ref] of refs.entries()) {
    const which = refs.length > 1 ? `image ${i + 1} is` : "this image is";
    if (!rules.types.includes(ref.contentType)) return `${takes}; ${which} ${TYPE_NAMES[ref.contentType] ?? ref.contentType}`;
    if (ref.bytes > rules.maxBytes) return `${takes}; ${which} ${(ref.bytes / MB).toLocaleString("en", { maximumFractionDigits: 1 })} MB`;
  }
  return undefined;
}

export type VideoRules = { network: string; types: readonly string[]; maxBytes: number };
/** Networks state limits in decimal megabytes, so this errs on the small side of either reading. */
export const MB = 1_000_000;
const TYPE_NAMES: Record<string, string> = { "video/mp4": "MP4", "video/quicktime": "MOV", "video/webm": "WebM", "image/png": "PNG", "image/jpeg": "JPEG", "image/gif": "GIF", "image/webp": "WebP" };

/** Why this file can't go on this network, in a person's words, or undefined when it can. */
export function refuseVideo(ref: MediaRef, rules: VideoRules | undefined): string | undefined {
  if (!rules) return "this network takes no video here";
  const takes = `${rules.network} takes ${rules.types.map((t) => TYPE_NAMES[t] ?? t).join(" or ")} up to ${Math.floor(rules.maxBytes / MB)} MB`;
  if (!rules.types.includes(ref.contentType)) return `${takes}; this file is ${TYPE_NAMES[ref.contentType] ?? ref.contentType}`;
  if (ref.bytes > rules.maxBytes) return `${takes}; this file is ${Math.ceil(ref.bytes / MB)} MB`;
  return undefined;
}

/** What a network says of an uploaded video: ready, still working, or failed with its reason. */
export type Processing = { state: "ready" } | { state: "processing" } | { state: "failed"; detail: string };

/**
 * Asks until the network has processed the video. Still processing at the end is `later`: nothing is
 * posted, and the retry uploads again. A failure waits for a person, since the same file fails again.
 */
export async function untilProcessed(check: () => Promise<Processing>, wait: { everyMs: number; forMs: number }, network: string): Promise<true | Refused> {
  const end = Date.now() + wait.forMs;
  for (;;) {
    const s = await check();
    if (s.state === "ready") return true;
    if (s.state === "failed") return held(`${network} could not process the video: ${s.detail}`);
    if (Date.now() + wait.everyMs > end) return later(`${network} was still processing the video`);
    await new Promise((r) => setTimeout(r, wait.everyMs));
  }
}

/** The one video an approved post carries, or null for a text post or one with images. */
export const videoOf = (s: PostSpec): MediaRef | null => {
  const m = s.media?.[0];
  return m && !isImage(m) ? m : null;
};

/** The images an approved post carries, in order, each with its alt text ("" when none was written). */
export const imagesOf = (s: PostSpec): { ref: MediaRef; alt: string }[] => (s.media ?? []).filter(isImage).map((ref, i) => ({ ref, alt: s.alt?.[i] ?? "" }));

/** No network call and nothing time-varying: what this returns is what a person approves. Never cuts text to fit. */
export function preparePost(raw: unknown, rules: PostRules) {
  const p = input.safeParse(raw);
  if (!p.success) throw new Error("this is not a post");
  const { links, target } = p.data;
  if (rules.needsTarget && !target) throw new Error("no account chosen");
  const shaped = (t: string) => (links ? t : removeLinks(t));
  const text = shaped(p.data.text);
  if (!text.trim()) throw new Error("the post is empty");
  const followUps = p.data.followUps.map(shaped).filter((t) => t.trim());
  if (followUps.length > rules.maxFollowUps) throw new Error(rules.maxFollowUps ? `${followUps.length} of ${rules.maxFollowUps} follow-ups` : "this network takes no follow-ups here");
  const fit = (t: string, where: string) => {
    const c = rules.count?.(t);
    if (c && c.used > c.limit) throw new Error(`${where}${c.used} of ${c.limit} characters`);
    const other = rules.refuse?.(t);
    if (other) throw new Error(`${where}${other}`);
    return c;
  };
  const count = fit(text, "");
  followUps.forEach((t, i) => fit(t, `follow-up ${i + 1}: `));
  const media = p.data.media;
  const images = media?.filter(isImage) ?? [];
  if (media && images.length && images.length !== media.length) throw new Error("a post carries a video or images, not both");
  if (media && !images.length && media.length > 1) throw new Error("a post carries one video");
  const refusal = !media ? undefined : images.length ? refuseImages(images, rules.image) : refuseVideo(media[0]!, rules.video);
  if (refusal) throw new Error(refusal);
  const alt = images.length ? images.map((_, i) => (p.data.alt?.[i] ?? "").trim()) : undefined;
  return { spec: { text, followUps, target, ...(media && { media }), ...(alt && { alt }) } satisfies PostSpec, preview: [text, ...followUps].join("\n\n"), ...(count && { count }) };
}

/**
 * The post is already out, so nothing here can fail it. A refusal is "failed", anything thrown may have
 * posted, and either one stops the rest, since each builds on the one before.
 */
// ponytail: all follow-ups run inside one execute, so a long list on a slow network can hit the effect's timeout and go to a person. Job steps with stored progress if that shows up.
export async function runFollowUps(texts: readonly string[], post: (text: string, index: number) => Promise<{ url?: string | undefined } | Refused>): Promise<FollowUpResult[]> {
  const out: FollowUpResult[] = [];
  for (const [i, text] of texts.entries()) {
    const stopper = out.findIndex((f) => f.status !== "posted");
    if (stopper >= 0) {
      out.push({ status: "failed", detail: `not attempted, because follow-up ${stopper + 1} did not post` });
      continue;
    }
    try {
      const r = await post(text, i);
      out.push(isRefused(r) ? { status: "failed", ...(r.detail && { detail: r.detail }) } : { status: "posted", ...(r.url && { url: r.url }) });
    } catch {
      out.push({ status: "uncertain", detail: "the connection dropped or the network failed, so this may have posted" });
    }
  }
  return out;
}

export const sent = (providerRef: string, url: string | undefined, followUps: FollowUpResult[]): ExecuteResult => ({ kind: "sent", providerRef, ...(url && { url }), ...(followUps.length && { followUps }) });
