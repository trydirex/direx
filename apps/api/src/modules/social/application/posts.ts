// SPDX-License-Identifier: AGPL-3.0-only
// Posts: one Item per Network account per campaign step, or per clip and account for a clips step. Where a Network can publish here the Item is an
// Action, and the ledger does the rest. Everywhere else it is copy and paste, and no plugin ever runs.
import { storedSpec } from "@direx/plugin-sdk/host";
import type { SocialNetworkInfo } from "../domain/network";
import type { Vault } from "../../credentials/index";
import { warn, type Items, type ItemKind, type Warning } from "../../items/index";
import type { Media } from "../../media/index";
import { specHash, type Actor, type Check } from "../../ledger/index";
import type { Plugins, Prepared as PreparedSpec } from "../../plugins/index";
import { accountOf, existingPost, insertPost, inWorkspace, keepPreview, linkImageOf, listPosts, postOfItem, postToEdit, markManualPosted, ownAppExists, postsInMonth, replacePost, runByOf, specOfAction, withinSlot, type SocialTx } from "../adapters/repo";
import { canDo } from "../domain/can-do";
import { isPublicUrl } from "../domain/public-url";
import { firstLink, imageType, mustRead, type KeptPreview, type LinkPreview } from "../domain/link-preview";
import { handPostWarning } from "./account-health";

export const MANUAL_POST = "manual_post";
/** The most images one post carries here [DEFAULT]; each network's plugin may take fewer. */
export const MAX_IMAGES = 4;
/** [DEFAULT] Two posts on one account closer than this share a slot. */
export const SLOT_MS = 15 * 60_000;
const LINKS_REMOVED = "Links were removed. This network keeps them only with your own app.";
const SAME_TEXT = "This network treats one text on several of its accounts as spam. Write a version for each.";
const SAME_SLOT = "Another post on this account is planned within 15 minutes.";
/** Warnings about what the words claim; a rewrite checked again replaces them. */
const CLAIM_CODES: ReadonlySet<string> = new Set(["uncited_number", "banned_claim"]);
const UNLABELLED = "Say who runs this account on the account itself, then note it under Run by.";
const LONG_TAIL = " characters. Shorten it before you post it.";
/** A post copied by hand has no plugin to count it, so its network's known limit warns here, keeping it out of approve all. */
const tooLong = (n: SocialNetworkInfo, text: string): Warning[] => {
  const over = n.postLimit ? [...text].length - n.postLimit : 0;
  return over > 0 ? [warn("unspecified", `Over the ${n.label} limit of ${n.postLimit} by ${over}${LONG_TAIL}`)] : [];
};

/** A post written on the Calendar is titled by its network and its first words. */
const calendarTitle = (n: SocialNetworkInfo, text: string) => `${n.label}: ${[...text].slice(0, 60).join("").trim()}`;

export type PostTarget = {
  connection: string;
  credentialId: string | null;
  networkId: string | null;
  text: string;
  followUps?: string[] | undefined;
  /** An uploaded video the post carries. */
  mediaId?: string | null | undefined;
  /** Uploaded images the post carries instead, in the order shown, with what a screen reader says for each. */
  mediaIds?: readonly string[] | undefined;
  alt?: readonly string[] | undefined;
  /** The clip a clips step posts here. One account may carry several clips of one step, each its own post. */
  clipId?: string | null | undefined;
  /** When this post goes out, if not at the step's time. */
  at?: Date | undefined;
  /** The Fact versions the text relies on. A change after approval holds a post the ledger sends. */
  citations?: readonly { factId: string; version: number }[] | undefined;
};
export type DraftStep = { campaignId: string; stepKey: string; title: string; plannedAt: Date };
export type PostResult = { connection: string; networkId: string | null; ok: boolean; itemId?: string; mode?: "publish" | "manual"; reason?: string; detail?: string };
/** A prepared post, with the text the network will show. */
type Prepared = PreparedSpec & { text: string | undefined };

export type PostsDeps = {
  plugins: () => Pick<Plugins, "socialFor" | "prepare" | "capabilityVersion">;
  vault: () => Pick<Vault, "appSource">;
  networks: () => readonly SocialNetworkInfo[];
  items: () => Items;
  /** Where a post's video is looked up; without it a post can't carry one. */
  media?: () => Pick<Media, "ref">;
  /** This deployment's address. A network that fetches a video itself needs it public. */
  baseUrl?: () => string;
  /** Campaigns launching on a day, asked of campaigns through the composition root, so posts never import it. */
  launchesOn?: (workspaceId: string, day: string) => Promise<readonly { campaignId: string; title: string }[]>;
  now?: () => Date;
};

const refusal = (e: unknown) => (e as Error).message.replace(/^plugin error: /, "");

/** A post confirmed after an uncertain publish has no report of its follow-ups, so none reads as posted. */
function followUpsOf(r: { spec: unknown; result: unknown; state: string | null }): { status: string; detail?: string }[] {
  const reported = (r.result as { followUps?: { status: string; detail?: string }[] } | null)?.followUps;
  if (reported) return reported;
  const planned = storedSpec("social.publish", r.spec).followUps ?? [];
  return r.state === "sent" ? planned.map(() => ({ status: "uncertain" })) : [];
}

/** The video a post carries: from a hand post's payload with its name, or from an approved spec. */
function videoInList(spec: unknown, payload: unknown): { mediaId: string; fileName: string | null } | null {
  const hand = (payload as { video?: { mediaId: string; fileName: string } } | null)?.video;
  if (hand) return { mediaId: hand.mediaId, fileName: hand.fileName };
  const ref = storedSpec("social.publish", spec).media?.[0];
  return ref && !ref.contentType.startsWith("image/") ? { mediaId: ref.mediaId, fileName: null } : null;
}

/** The images a post carries, in order: from a hand post's payload with their names, or from an approved spec. */
function imagesInList(spec: unknown, payload: unknown): { mediaId: string; fileName: string | null; alt: string }[] {
  const hand = (payload as { images?: { mediaId: string; fileName: string; alt: string }[] } | null)?.images;
  if (hand) return hand;
  const s = storedSpec("social.publish", spec);
  return (s.media ?? []).filter((m) => m.contentType.startsWith("image/")).map((m, i) => ({ mediaId: m.mediaId, fileName: null, alt: s.alt?.[i] ?? "" }));
}

export function createPosts(deps: PostsDeps) {
  const now = deps.now ?? (() => new Date());
  const network = (connection: string) => deps.networks().find((n) => n.connection === connection);

  /** The approved file a post binds, by hash, or null for a text post. */
  async function videoOf(workspaceId: string, t: PostTarget) {
    if (!t.mediaId) return null;
    const found = await deps.media?.().ref(workspaceId, t.mediaId);
    return found ? { ref: { mediaId: found.mediaId, sha256: found.sha256, bytes: found.bytes, contentType: found.contentType }, fileName: found.fileName } : undefined;
  }

  /** The approved images a post binds, by hash, in order: none for a text post, undefined when one isn't an uploaded image. */
  async function imagesOf(workspaceId: string, t: PostTarget) {
    const out: { ref: { mediaId: string; sha256: string; bytes: number; contentType: string }; fileName: string }[] = [];
    for (const id of t.mediaIds ?? []) {
      const found = await deps.media?.().ref(workspaceId, id);
      if (!found || !found.contentType.startsWith("image/")) return undefined;
      out.push({ ref: { mediaId: found.mediaId, sha256: found.sha256, bytes: found.bytes, contentType: found.contentType }, fileName: found.fileName });
    }
    return out;
  }

  /** What this target can be: published, copied by hand, or neither yet. */
  async function resolve(workspaceId: string, t: PostTarget) {
    const n = network(t.connection);
    if (!n) return { ok: false, reason: "unknown_network" } as const;
    if (t.mediaId && t.mediaIds?.length) return { ok: false, reason: "video_and_images" } as const;
    if ((t.mediaIds?.length ?? 0) > MAX_IMAGES) return { ok: false, reason: "too_many_images" } as const;
    const video = await videoOf(workspaceId, t);
    const images = await imagesOf(workspaceId, t);
    if (video === undefined || images === undefined) return { ok: false, reason: "unknown_media" } as const;
    const provider = deps.plugins().socialFor(t.connection);
    const account = t.credentialId && t.networkId ? await inWorkspace(workspaceId, (tx) => accountOf(tx, t.credentialId!, t.networkId!)) : null;
    if (t.credentialId && !account) return { ok: false, reason: "unknown_account" } as const;
    const feature = (key: string) => n.features.find((f) => f.key === key);
    const publish = feature("publish");
    if (!provider?.publish || !publish?.built) return { ok: true, mode: "manual", n, account, video, images } as const;
    if (!account) return { ok: false, reason: "account_required" } as const;
    const own = (await deps.vault().appSource(workspaceId, t.connection)) === "own";
    const scopes = (account.meta as { scopes?: string[] }).scopes ?? [];
    const status = (key: string) => {
      const f = feature(key);
      return f ? canDo(f, scopes, own) : "coming";
    };
    if (status("publish") !== "available") return { ok: false, reason: status("publish") === "reconnect" ? "reconnect" : "not_available" } as const;
    if (t.followUps?.length && status("follow_ups") !== "available") return { ok: false, reason: "follow_ups_not_available" } as const;
    if (video) {
      const v = status("video");
      const unreachable = feature("video")?.needsPublicUrl && !isPublicUrl(deps.baseUrl?.() ?? "");
      if (unreachable) return { ok: true, mode: "manual", n, account, video, images } as const;
      // An older connection lacks a scope video needs: posting it by hand would hide a one-click fix.
      if (v === "reconnect") return { ok: false, reason: "reconnect_for_video" } as const;
      if (v !== "available") return { ok: true, mode: "manual", n, account, video, images } as const;
    }
    if (images.length) {
      const unreachable = feature("image")?.needsPublicUrl && !isPublicUrl(deps.baseUrl?.() ?? "");
      if (unreachable || status("image") === "coming") return { ok: true, mode: "manual", n, account, video, images } as const;
      if (status("image") === "reconnect") return { ok: false, reason: "reconnect_for_images" } as const;
      if (status("image") !== "available") return { ok: true, mode: "manual", n, account, video, images } as const;
    }
    return { ok: true, mode: "publish", n, account, video, images, provider: provider as { publish: string; dedupe: NonNullable<typeof provider.dedupe> }, links: status("links") === "available" } as const;
  }

  async function prepared(workspaceId: string, t: PostTarget, r: { provider: { publish: string }; links: boolean; video: { ref: object } | null; images: { ref: object }[] }) {
    // A text post's input has no media, so its approval hash is as it was before video and images.
    const media = r.video ? { media: [r.video.ref] } : r.images.length ? { media: r.images.map((i) => i.ref), alt: r.images.map((_, i) => t.alt?.[i] ?? "") } : {};
    const input = { text: t.text, followUps: t.followUps ?? [], target: t.networkId, links: r.links, ...media };
    const p = await deps.plugins().prepare(workspaceId, r.provider.publish, input);
    return { ...p, text: storedSpec("social.publish", p.spec).text };
  }

  /**
   * A Calendar post outside any campaign, made as a step's post is, and always waiting for approval:
   * never approved or scheduled here. `actor` is who wrote it, a person or a system actor such as an
   * External token (ADR 0032 rule 004), and `extra` warnings go on the Item with the post's own, such as
   * `untrusted_source`, which keeps it out of approve-all.
   */
  async function writeAs(workspaceId: string, t: PostTarget & { at: Date }, actor: Actor, extra: readonly Warning[] = []): Promise<PostResult> {
    const base = { connection: t.connection, networkId: t.networkId };
    // A time already gone can't be posted at, as a move to one is refused.
    if (t.at <= now()) return { ...base, ok: false, reason: "slot_in_past" };
    const r = await resolve(workspaceId, t);
    if (!r.ok) return { ...base, ...r };
    const networkId = t.networkId ?? "";
    const warnings: Warning[] = [...extra];
    const crowded = t.networkId && (await inWorkspace(workspaceId, (tx) => withinSlot(tx, { connection: t.connection, networkId, except: null, at: t.at, ms: SLOT_MS })));
    if (crowded) warnings.push(warn("unspecified", SAME_SLOT));
    if (r.mode === "manual") warnings.push(...tooLong(r.n, t.text));
    const details = { title: calendarTitle(r.n, t.text), workArea: "social", channel: t.connection, plannedAt: t.at, warnings };
    const record = (itemId: string, actionId: string | null) =>
      inWorkspace(workspaceId, (tx) => insertPost(tx, { workspaceId, campaignId: null, stepKey: `calendar:${itemId}`, connection: t.connection, networkId, credentialId: t.credentialId, accountName: r.account?.name ?? null, itemId, actionId, clipId: null, createdAt: now() }));
    if (r.mode === "manual") {
      const payload = { text: t.text, followUps: t.followUps ?? [] };
      const made = await deps.items().createItem(workspaceId, { kind: MANUAL_POST, state: "needs_approval", payload, actor, details: { ...details, snapshot: [] } });
      if (!made.ok) return { ...base, ok: false, reason: made.reason };
      await record(made.item.id, null);
      return { ...base, ok: true, itemId: made.item.id, mode: "manual" };
    }
    let p: Prepared;
    try {
      p = await prepared(workspaceId, t, r);
    } catch (e) {
      return { ...base, ok: false, reason: "refused_by_network", detail: refusal(e) };
    }
    if (!r.links && p.text !== t.text) warnings.push(warn("unspecified", LINKS_REMOVED));
    const version = deps.plugins().capabilityVersion(r.provider.publish);
    const item = await deps.items().createActionItem(workspaceId, {
      idempotencyKey: `social:calendar:${crypto.randomUUID()}`,
      capability: r.provider.publish,
      dedupe: r.provider.dedupe,
      spec: p.spec,
      credentialId: t.credentialId,
      actor,
      details: { ...details, snapshot: version ? [{ kind: "capability", id: r.provider.publish, version }] : [] },
    });
    await record(item.id, await deps.items().actionIdOf(workspaceId, item.id));
    await deps.items().submitItem(workspaceId, item.id, actor);
    return { ...base, ok: true, itemId: item.id, mode: "publish" };
  }

  return {
    /** What a draft would become, changing nothing: the text after the Network's rules, and its count. */
    async preview(workspaceId: string, t: PostTarget): Promise<PostResult & { text?: string; count?: { used: number; limit: number } }> {
      const base = { connection: t.connection, networkId: t.networkId };
      const r = await resolve(workspaceId, t);
      if (!r.ok) return { ...base, ...r };
      if (r.mode === "manual") return { ...base, ok: true, mode: "manual", text: t.text };
      try {
        const p = await prepared(workspaceId, t, r);
        return { ...base, ok: true, mode: "publish", text: String(p.text ?? t.text), ...(p.count && { count: p.count }) };
      } catch (e) {
        return { ...base, ok: false, reason: "refused_by_network", detail: refusal(e) };
      }
    },

    /** Writing the same step again revises each draft under the same Action, voiding any approval. */
    async draft(workspaceId: string, step: DraftStep, targets: readonly PostTarget[], userId: string): Promise<PostResult[]> {
      const actor = { userId };
      const results: PostResult[] = [];
      for (const t of targets) {
        const base = { connection: t.connection, networkId: t.networkId };
        const clipId = t.clipId ?? null;
        const at = t.at ?? step.plannedAt;
        // A clip's posts group on their own, so the Calendar shows each clip once.
        const groupKey = `campaign:${step.campaignId}:step:${step.stepKey}${clipId ? `:clip:${clipId}` : ""}`;
        const cited = (t.citations ?? []).map((c) => ({ kind: "fact", id: c.factId, version: String(c.version) }));
        const r = await resolve(workspaceId, t);
        if (!r.ok) {
          results.push({ ...base, ...r });
          continue;
        }
        const networkId = t.networkId ?? "";
        const warnings: Warning[] = [];
        const twin = r.n.noIdenticalAcrossAccounts && targets.some((o) => o !== t && o.connection === t.connection && o.networkId !== t.networkId && o.text === t.text);
        if (twin) warnings.push(warn("unspecified", SAME_TEXT));
        const crowded = t.networkId && (await inWorkspace(workspaceId, (tx) => withinSlot(tx, { connection: t.connection, networkId, except: step, at, ms: SLOT_MS })));
        if (crowded) warnings.push(warn("unspecified", SAME_SLOT));
        // One of several accounts on a network that doesn't say who runs it: a warning, never a hold.
        const about = t.credentialId && t.networkId ? await inWorkspace(workspaceId, (tx) => runByOf(tx, t.connection, t.credentialId!, networkId)) : null;
        if (about && about.onNetwork > 1 && !about.runBy) warnings.push(warn("unspecified", UNLABELLED));
        // ponytail: the day is read in UTC; read it in the Workspace's zone once Workspaces have one.
        for (const other of (await deps.launchesOn?.(workspaceId, at.toISOString().slice(0, 10))) ?? []) {
          if (other.campaignId !== step.campaignId) warnings.push(warn("unspecified", `Campaign "${other.title}" launches that day.`));
        }
        if (r.mode === "manual") warnings.push(...tooLong(r.n, t.text));
        if (r.mode === "manual" && t.credentialId && t.networkId) {
          const account = { credentialId: t.credentialId, networkId: t.networkId };
          const over = await inWorkspace(workspaceId, (tx) => handPostWarning(tx, workspaceId, account, { text: t.text, followUps: t.followUps ?? [] }, at, now()));
          if (over) warnings.push(warn("unspecified", over));
        }
        const details = { title: `${r.n.label}: ${step.title}`, workArea: "social", channel: t.connection, plannedAt: at, warnings, groupKey, groupLabel: step.title };
        const found = await inWorkspace(workspaceId, (tx) => existingPost(tx, step.campaignId, step.stepKey, t.connection, networkId, clipId));
        // A cancelled post can't be revised, so a new one takes its place on the step.
        const existing = found?.cancelled ? null : found;
        const record = (itemId: string, actionId: string | null) =>
          inWorkspace(workspaceId, (tx) => {
            const row = { workspaceId, campaignId: step.campaignId, stepKey: step.stepKey, connection: t.connection, networkId, credentialId: t.credentialId, accountName: r.account?.name ?? null, itemId, actionId, clipId, createdAt: now() };
            return found?.cancelled ? replacePost(tx, found.id, row) : insertPost(tx, row);
          });

        if (r.mode === "manual") {
          // A text post's payload stays as it was before video, so its revision doesn't change.
          const payload = {
            text: t.text,
            followUps: t.followUps ?? [],
            ...(r.video && { video: { mediaId: r.video.ref.mediaId, fileName: r.video.fileName } }),
            ...(r.images.length && { images: r.images.map((i, n) => ({ mediaId: i.ref.mediaId, fileName: i.fileName, alt: t.alt?.[n] ?? "" })) }),
          };
          if (existing) {
            const revised = await deps.items().reviseOwnItem(workspaceId, existing.itemId, { payload, details: { ...details, snapshot: cited }, actor });
            results.push(revised.ok ? { ...base, ok: true, itemId: existing.itemId, mode: "manual" } : { ...base, ok: false, reason: revised.reason });
            continue;
          }
          const made = await deps.items().createItem(workspaceId, { kind: MANUAL_POST, state: "needs_approval", payload, actor, details: { ...details, snapshot: cited } });
          if (!made.ok) {
            results.push({ ...base, ok: false, reason: made.reason });
            continue;
          }
          // ponytail: two requests at once can leave a second Item with no post row. A person can cancel it; a shared transaction with items if it shows up.
          await record(made.item.id, null);
          results.push({ ...base, ok: true, itemId: made.item.id, mode: "manual" });
          continue;
        }

        let p: Prepared;
        try {
          p = await prepared(workspaceId, t, r);
        } catch (e) {
          results.push({ ...base, ok: false, reason: "refused_by_network", detail: refusal(e) });
          continue;
        }
        if (!r.links && p.text !== t.text) warnings.push(warn("unspecified", LINKS_REMOVED));
        const version = deps.plugins().capabilityVersion(r.provider.publish);
        const snapshot = [...(version ? [{ kind: "capability", id: r.provider.publish, version }] : []), ...cited];
        if (existing) {
          const same = await inWorkspace(workspaceId, (tx) => specOfAction(tx, existing.actionId!));
          // jsonb reorders keys, so the same text must compare as the same.
          if (specHash(same) === specHash(p.spec)) {
            await deps.items().setWarnings(workspaceId, existing.itemId, warnings);
            results.push({ ...base, ok: true, itemId: existing.itemId, mode: "publish" });
            continue;
          }
          const revised = await deps.items().reviseActionItem(workspaceId, existing.itemId, { spec: p.spec, actor, details: { ...details, snapshot } });
          results.push(revised.ok ? { ...base, ok: true, itemId: existing.itemId, mode: "publish" } : { ...base, ok: false, reason: revised.reason });
          continue;
        }
        const item = await deps.items().createActionItem(workspaceId, {
          // Keep the original key for a first draft. A replacement follows the cancelled Action, or Item for a hand post.
          idempotencyKey: `social:${step.campaignId}:${step.stepKey}:${t.connection}:${networkId}${clipId ? `:${clipId}` : ""}${found?.cancelled ? `:after:${found.actionId ?? found.itemId}` : ""}`,
          capability: r.provider.publish,
          dedupe: r.provider.dedupe,
          spec: p.spec,
          credentialId: t.credentialId,
          actor,
          details: { ...details, snapshot },
        });
        const fresh = await deps.items().actionIdOf(workspaceId, item.id);
        await record(item.id, fresh);
        await deps.items().submitItem(workspaceId, item.id, actor);
        results.push({ ...base, ok: true, itemId: item.id, mode: "publish" });
      }
      return results;
    },

    /** A post a person writes on the Calendar, as they wrote it: see `writeAs`. */
    write: (workspaceId: string, t: PostTarget & { at: Date }, userId: string) => writeAs(workspaceId, t, { userId }),
    writeAs,

    /**
     * A person's own words for a post, checked by its network as a draft is. Its follow-ups, video and
     * images stay. An approval it had is void, so it waits for approval again; the words cite no Fact.
     * `checked` is what a rewrite's words were checked for: its claim warnings replace the old ones, and its Facts are cited.
     */
    async edit(workspaceId: string, itemId: string, text: string, userId: string, checked?: { warnings: Warning[]; citations: readonly { factId: string; version: number }[] }): Promise<{ ok: true; count?: { used: number; limit: number } } | { ok: false; reason: string; detail?: string }> {
      const actor = { userId };
      const row = await inWorkspace(workspaceId, (tx) => postToEdit(tx, itemId));
      const view = row && (await deps.items().view(workspaceId, itemId));
      if (!row || !view) return { ok: false, reason: "not_found" };
      const video = videoInList(row.spec, row.payload);
      const images = imagesInList(row.spec, row.payload);
      // A post copied by hand has a payload of the same words instead of a spec.
      const followUps = storedSpec("social.publish", row.spec ?? row.payload).followUps ?? [];
      const t: PostTarget = { connection: row.connection, credentialId: row.credentialId, networkId: row.networkId || null, text, followUps, mediaId: video?.mediaId ?? null, ...(images.length && { mediaIds: images.map((i) => i.mediaId), alt: images.map((i) => i.alt) }) };
      const r = await resolve(workspaceId, t);
      if (!r.ok) return r;
      // Only words change here: a post copied by hand stays one, and one Direx publishes stays under its Action.
      if ((r.mode === "publish") !== Boolean(row.actionId)) return { ok: false, reason: "not_available" };
      const warnings = [...view.warnings.filter((w) => w.text !== LINKS_REMOVED && !w.text.endsWith(LONG_TAIL) && !(checked && CLAIM_CODES.has(w.code))), ...(checked?.warnings ?? [])];
      const cited = (checked?.citations ?? []).map((c) => ({ kind: "fact", id: c.factId, version: String(c.version) }));
      // A Calendar post's title is its first words, so it follows them; a step's post keeps its step's title.
      const title = row.campaignId ? view.title : calendarTitle(r.n, text);
      if (r.mode === "manual") {
        warnings.push(...tooLong(r.n, text));
        const payload = { ...(row.payload as object), text };
        const details = { title, workArea: view.workArea, channel: view.channel, groupKey: view.groupKey, groupLabel: view.groupLabel, plannedAt: view.at, warnings, snapshot: cited };
        const revised = await deps.items().reviseOwnItem(workspaceId, itemId, { payload, details, actor });
        return revised.ok ? { ok: true } : revised;
      }
      let p: Prepared;
      try {
        p = await prepared(workspaceId, t, r);
      } catch (e) {
        return { ok: false, reason: "refused_by_network", detail: refusal(e) };
      }
      if (!r.links && p.text !== text) warnings.push(warn("unspecified", LINKS_REMOVED));
      const version = deps.plugins().capabilityVersion(r.provider.publish);
      const revised = await deps.items().reviseActionItem(workspaceId, itemId, { spec: p.spec, actor, details: { title, warnings, snapshot: [...(version ? [{ kind: "capability", id: r.provider.publish, version }] : []), ...cited] } });
      return revised.ok ? { ok: true, ...(p.count && { count: p.count }) } : { ok: false, reason: revised.reason };
    },

    /** A campaign post's step, words and where it stands, for a rewrite asked of its writer. Null for any other Item. */
    async ofItem(workspaceId: string, itemId: string) {
      const row = await inWorkspace(workspaceId, (tx) => postToEdit(tx, itemId));
      const view = row?.campaignId ? await deps.items().view(workspaceId, itemId) : null;
      if (!row?.campaignId || !view) return null;
      return { campaignId: row.campaignId, stepKey: row.stepKey, text: storedSpec("social.publish", row.spec ?? row.payload).text ?? "", state: view.state, revision: view.revision };
    },

    /** Every post of a step, with its text and what became of it. */
    list: (workspaceId: string, campaignId: string, stepKey: string) => inWorkspace(workspaceId, (tx) => listPosts(tx, campaignId, stepKey)).then(async (rows) => Promise.all(rows.map(async (r) => ({
      id: r.id,
      itemId: r.itemId,
      clipId: r.clipId,
      connection: r.connection,
      network: network(r.connection)?.label ?? r.connection,
      accountName: r.accountName,
      mode: r.actionId ? ("publish" as const) : ("manual" as const),
      text: storedSpec("social.publish", r.spec ?? r.payload).text ?? "",
      video: videoInList(r.spec, r.payload),
      images: imagesInList(r.spec, r.payload),
      url: (r.result as { url?: string } | null)?.url ?? r.postedUrl,
      followUps: followUpsOf(r),
      item: (await deps.items().view(workspaceId, r.itemId))!,
    })))),

    /** The person posted it by hand. Only after approval, and it stays labelled as theirs. */
    markPosted: (workspaceId: string, itemId: string, url: string | null, userId: string) => deps.items().finishOwnItem(workspaceId, itemId, { userId }, (tx) => markManualPosted(tx, itemId, url)),
  };
}
export type Posts = ReturnType<typeof createPosts>;

/** Approving copy and paste changes nothing outside Direx. It waits for the person to post it. */
export const socialKinds = (): Record<string, ItemKind> => ({
  [MANUAL_POST]: { permission: "item.approve", waitsForPerson: true, apply: async () => ({ ok: true }) },
});

/** Holds a post once the Workspace has used its month on an app Direx pays for. */
export const postLimitCheck =
  (deps: { plugins: () => Pick<Plugins, "socialFor">; networks: () => readonly SocialNetworkInfo[]; now: () => Date }): Check =>
  async (tx, action) => {
    const n = deps.networks().find((x) => x.monthlyPostLimit && deps.plugins().socialFor(x.connection)?.publish === action.capability);
    if (!n?.monthlyPostLimit || (await ownAppExists(tx as SocialTx, n.connection))) return { kind: "ok" };
    // ponytail: counts without the Workspace lock, so workers racing at the limit can pass it by a post or two. A cost guard, not a promise; the budget path replaces it.
    const used = await postsInMonth(tx as SocialTx, action.capability, action.id, deps.now());
    return used >= n.monthlyPostLimit ? { kind: "hold", reason: "post_limit_reached", detail: `${used} of ${n.monthlyPostLimit} this month` } : { kind: "ok" };
  };

/** How a post's Item shows: the account it goes out as and its network's name, read when it is viewed. */
/** Reads one page for a link's preview card; null when it can't. */
export type ReadPreview = (url: string) => Promise<LinkPreview | null>;
/** Fetches the image a page names for its card; null when it can't. */
export type ReadImage = (url: string) => Promise<{ bytes: Buffer } | null>;

/** A post as its network will show it: the account, the network, and its first link's card. The card and
    its image are read the first time the post is looked at with that link, and kept; a page that couldn't
    be read is tried again a day later. The card says whether there's an image, never where it came from:
    the browser loads it from Direx. */
export async function postAppearance(workspaceId: string, itemId: string, networks: readonly SocialNetworkInfo[], o: { text?: string | null; readPreview?: ReadPreview; readImage?: ReadImage; now?: Date } = {}) {
  const [row] = await inWorkspace(workspaceId, (tx) => postOfItem(tx, itemId));
  if (!row) return null;
  const url = o.text ? firstLink(o.text) : null;
  let link = null;
  if (url && o.readPreview) {
    const now = o.now ?? new Date();
    const kept = row.linkPreview as KeptPreview | null;
    let preview = kept?.preview ?? null;
    let hasImage = row.hasImage;
    if (mustRead(kept, url, now)) {
      preview = await o.readPreview(url);
      const got = preview?.image && o.readImage ? await o.readImage(preview.image) : null;
      const type = got && imageType(got.bytes);
      const image = got && type ? { type, bytes: got.bytes } : null;
      hasImage = image !== null;
      await inWorkspace(workspaceId, (tx) => keepPreview(tx, row.id, { url, preview, at: now.toISOString() } satisfies KeptPreview, image));
    }
    link = preview && { url, title: preview.title, description: preview.description, site: preview.site, image: hasImage };
  }
  return { kind: "post" as const, account: row.accountName, network: networks.find((n) => n.connection === row.connection)?.label ?? row.connection, link };
}

/** The image of a post's link card, to serve from Direx. */
export async function postLinkImage(workspaceId: string, itemId: string) {
  const [row] = await inWorkspace(workspaceId, (tx) => linkImageOf(tx, itemId));
  return row?.bytes && row.type ? { bytes: row.bytes, type: row.type } : null;
}
