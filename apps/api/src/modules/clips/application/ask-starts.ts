// SPDX-License-Identifier: AGPL-3.0-only
// The Clips screen's "pick clips", as a start a person can ask for in Ask (ADR 0008 rule 028). It
// starts the button's own clip run, whose moment picker comes later inside it, so the work it
// reports is the clip run, done only once its clips are cut. Its args are a media id only, so no
// model text reaches the run.
import { z } from "zod";
import { askStart, type AskStart } from "../../agents/index";
import type { Media } from "../../media/index";
import { liveRunOf } from "../adapters/repo";
import { clipPicker } from "../definitions/clip-picker";
import type { Clips } from "./runs";

const CLIP = "clip_run";

export function clipAskStarts(d: { clips: () => Pick<Clips, "start" | "get">; media: () => Pick<Media, "ref"> }): AskStart[] {
  return [
    askStart({
      id: "pick_clips",
      definition: clipPicker.id,
      area: "social",
      says: "Pick short captioned clips from one uploaded video. Args: mediaId, from read_media.",
      args: z.strictObject({ mediaId: z.uuid() }),
      permission: "item.edit",
      async check(workspaceId, a) {
        const file = await d.media().ref(workspaceId, a.mediaId);
        if (!file) return { ok: false, why: "not_found" };
        if (await liveRunOf(workspaceId, a.mediaId)) return { ok: false, why: "in_progress" };
        return { ok: true, title: `Pick clips from ${file.fileName}`, basis: `media:${file.sha256}` };
      },
      // One live run per video: a retry finds the run it already started and points at it.
      async start(workspaceId, a, by) {
        const r = await d.clips().start(workspaceId, { mediaId: a.mediaId, userId: by.userId });
        if (r.ok) return { ok: true, work: { kind: CLIP, id: r.run.id } };
        const live = r.reason === "in_progress" ? await liveRunOf(workspaceId, a.mediaId) : undefined;
        return live ? { ok: true, work: { kind: CLIP, id: live.id } } : { ok: false, why: r.reason };
      },
      async report(workspaceId, work) {
        if (work.kind !== CLIP) return null;
        const run = await d.clips().get(workspaceId, work.id);
        if (!run) return null;
        return { state: run.state === "done" ? "done" : run.state === "failed" ? "failed" : "running", itemIds: [] };
      },
    }),
  ];
}
