// SPDX-License-Identifier: AGPL-3.0-only
// A clips step: upload a recording, pick the accounts and the first post time, and Direx cuts clips and
// drafts a post for each, on one account, a day apart per account. A step takes one recording after
// another, newest shown first; a later one's posts skip the days an account already posts on. Each clip
// shows once with its posts, and one press approves that clip's posts that have no warnings. A post with
// warnings is approved on its own row. Nothing is posted until then.
import { useEffect, useState } from "react";
import { Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Input, Textarea } from "@/components/Input";
import { useAction } from "../components/useAction";
import { approveClean, ITEM_MESSAGES } from "../items/actions";
import { accounts as loadAccounts, megabytes, networks as loadNetworks, postsOf, uploadVideo, videoUrl, type Account, type Network, type Post, type Video } from "../social/actions";
import { clipStep, dayWords, editClipCaption, makeClips, sayClips, type ClipRecording, type ClipRunState, type ClipStepView, type Step, type StepClip } from "./actions";
import { choices, PostRow, refusedOf } from "./PostStep";

const WORKING: Record<Exclude<ClipRunState, "done" | "failed">, string> = {
  queued: "Waiting to start",
  transcribing: "Transcribing the recording",
  picking: "Picking the moments worth posting",
  cutting: "Cutting the clips",
};
/** How often a running step looks again: a run takes minutes. */
const POLL_MS = 5000;
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
const workingOf = (r: ClipRecording) => (r.run && r.run.state !== "done" && r.run.state !== "failed" ? WORKING[r.run.state] : null);
const shortDate = (iso: string) => dayWords(iso.slice(0, 10));

/** What one press on a clip approves: its posts still waiting that have no warnings. */
export const approvable = (posts: readonly Post[]) => posts.filter((x) => x.state === "needs_approval" && x.clean).map((x) => ({ id: x.itemId, revision: x.revision }));

function ClipCard(p: { workspaceId: string; id: string; stepKey: string; clip: StepClip; posts: Post[]; edit: boolean; approve: boolean; onChange: () => void }) {
  const { clip, posts } = p;
  const clean = approvable(posts);
  const [caption, setCaption] = useState(clip.caption);
  const [error, setError] = useState<string>();
  const approving = useAction(ITEM_MESSAGES);
  const saving = useAction();
  const facts = clip.citations.length;
  return (
    <article aria-label={clip.title} className="flex flex-col gap-3 rounded-card border border-border p-4">
      <h4 className="font-medium">{clip.title}</h4>
      <video className="rounded-card" controls preload="metadata" width={180} src={videoUrl(p.workspaceId, clip.mediaId)} />
      <p>{`${seconds(clip.endMs - clip.startMs)}. ${clip.why}${facts > 0 ? ` Backs ${facts} ${facts === 1 ? "brand fact" : "brand facts"}.` : ""}${clip.measureKey ? ` Moves the plan's ${clip.measureKey}.` : ""}`}</p>
      {p.approve && clean.length > 0 && (
        <Button
          type="button"
          size="sm"
          className="self-start"
          pending={approving.pending}
          onClick={() =>
            void approving.run(async () => {
              const r = await approveClean(p.workspaceId, clean);
              p.onChange();
              return refusedOf(r);
            })
          }
        >
          Approve this clip
        </Button>
      )}
      {approving.error && <Notice tone="error">{approving.error}</Notice>}
      {p.edit && posts.some((x) => x.state === "needs_approval") && (
        <form
          className="flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await saving.run(async () => {
              const failed = await editClipCaption(p.workspaceId, p.id, p.stepKey, clip.id, caption);
              setError(failed ? sayClips(failed) : undefined);
              p.onChange();
              return null;
            });
          }}
        >
          <div className="flex flex-col gap-1.5 text-sm font-medium">
            <Textarea label="Caption" value={caption} onChange={(e) => setCaption(e.target.value)} />
          </div>
          <Button type="submit" size="sm" variant="outline" className="self-start" disabled={!caption.trim() || caption === clip.caption} pending={saving.pending}>Save caption</Button>
          {error && <Notice tone="error">{error}</Notice>}
        </form>
      )}
      <ul className="flex flex-col">
        {posts.map((post) => <PostRow key={post.id} workspaceId={p.workspaceId} post={post} approve={p.approve} quiet={p.approve && clean.length > 0} onChange={p.onChange} />)}
      </ul>
    </article>
  );
}

/** One recording: what it is doing, why it stopped, or its clips with their posts. */
function RecordingView(p: { workspaceId: string; id: string; stepKey: string; rec: ClipRecording; posts: Post[]; edit: boolean; approve: boolean; retry: (() => void) | null; retrying: boolean; onChange: () => void }) {
  const { rec } = p;
  const working = workingOf(rec);
  const state = rec.run?.state;
  return (
    <section aria-label={`Recording for ${shortDate(rec.setup.firstAt)}`} className="flex flex-col gap-3">
      <h3 className="font-medium">{`Recording, first post ${shortDate(rec.setup.firstAt)}`}</h3>
      {working && <Notice>{`${working}. This takes a few minutes; you can leave this page.`}</Notice>}
      {state === "failed" && (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-card bg-destructive-tint px-4 py-3 text-destructive">
          <p>{`Clipping stopped: ${rec.run?.failure}. `}</p>
          {p.retry && (
            <Button type="button" size="sm" variant="outline" pending={p.retrying} onClick={p.retry}>
              Try again
            </Button>
          )}
        </div>
      )}
      {state === "done" && (
        <>
          {rec.clips.length === 0 && <p>No clips came out of this recording.</p>}
          {rec.clips.map((clip) => (
            <ClipCard key={clip.id} workspaceId={p.workspaceId} id={p.id} stepKey={p.stepKey} clip={clip} posts={p.posts.filter((x) => x.clipId === clip.id)} edit={p.edit} approve={p.approve} onChange={p.onChange} />
          ))}
          {rec.unposted.length > 0 && <p>{rec.unposted.length === 1 ? "1 more clip doesn't fit in a week of one post a day per account, so it isn't posted." : `${rec.unposted.length} more clips don't fit in a week of one post a day per account, so they aren't posted.`}</p>}
          {rec.idle.length > 0 && <p>{`${rec.idle.length === 1 ? "1 account gets" : `${rec.idle.length} accounts get`} no clip this time: there are more accounts than clips.`}</p>}
        </>
      )}
      {rec.run && rec.run.dropped.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Moments left out ({rec.run.dropped.length})</summary>
          <ul>
            {rec.run.dropped.map((d, i) => <li key={i}>{`${d.moment.title}: ${d.reason}`}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}

export function ClipsStep(p: { workspaceId: string; id: string; step: Step; edit: boolean; approve: boolean; initial?: { accounts: Account[]; networks: Network[]; view: ClipStepView; posts: Post[] } }) {
  const { workspaceId, id, step } = p;
  const [accounts, setAccounts] = useState(p.initial?.accounts ?? []);
  const [networks, setNetworks] = useState(p.initial?.networks ?? []);
  const [view, setView] = useState<ClipStepView | undefined>(p.initial?.view);
  const [posts, setPosts] = useState(p.initial?.posts ?? []);
  // Null until the person ticks one: until then the last recording's accounts are ticked.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [when, setWhen] = useState(step.on ? `${step.on}T09:00` : "");
  const [source, setSource] = useState<Video | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const starting = useAction();

  const recordings = view?.recordings ?? [];
  const reload = async () => {
    const v = await clipStep(workspaceId, id, step.key);
    setView(v);
    setPosts(v?.recordings.some((r) => r.run?.state === "done") ? await postsOf(workspaceId, id, step.key) : []);
  };
  useEffect(() => {
    void (async () => {
      const [a, n] = await Promise.all([loadAccounts(workspaceId), loadNetworks(workspaceId)]);
      setAccounts(a);
      setNetworks(n);
      await reload();
    })();
  }, [workspaceId, id, step.key]);

  const live = recordings.some((r) => workingOf(r));
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [live]);

  const options = choices(accounts, networks);
  const last = view?.lastAccounts ?? [];
  const ticked = chosen ?? options.filter((o) => last.some((a) => a.connection === o.connection && a.credentialId === o.credentialId && a.networkId === o.networkId)).map((o) => o.key);
  const picked = options.filter((o) => ticked.includes(o.key));
  const start = (body: Parameters<typeof makeClips>[3]) =>
    starting.run(async () => {
      const failed = await makeClips(workspaceId, id, step.key, body);
      setError(failed ? sayClips(failed) : undefined);
      if (!failed) setSource(null);
      await reload();
      return null;
    });

  return (
    <section aria-label={`Clips for ${step.title ?? step.key}`} className="flex flex-col gap-4">
      {error && <Notice tone="error">{error}</Notice>}
      {recordings.map((rec) => (
        <RecordingView
          key={rec.run?.id ?? rec.setup.firstAt}
          workspaceId={workspaceId}
          id={id}
          stepKey={step.key}
          rec={rec}
          posts={posts}
          edit={p.edit}
          approve={p.approve}
          retry={p.edit && !live ? () => void start(rec.setup) : null}
          retrying={starting.pending}
          onChange={() => void reload()}
        />
      ))}
      {p.edit && !live && (
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!source) return;
            await start({ sourceMediaId: source.id, accounts: picked.map(({ connection, credentialId, networkId }) => ({ connection, credentialId, networkId })), firstAt: new Date(when).toISOString() });
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{recordings.length ? "Another recording" : "Recording"}</legend>
            {source ? (
              <p>
                {source.fileName}, {megabytes(source.bytes)}{" "}
                <Button type="button" size="sm" variant="outline" onClick={() => setSource(null)}>
                  Choose another
                </Button>
              </p>
            ) : (
              <Input
                type="file"
                aria-label="Upload a recording"
                accept="video/mp4,video/quicktime,video/webm"
                disabled={uploading}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploading(true);
                  const r = await uploadVideo(workspaceId, file, "source");
                  setUploading(false);
                  if ("error" in r) setError(r.error);
                  else setSource(r.video);
                }}
              />
            )}
            {uploading && <Notice>Uploading.</Notice>}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Post to</legend>
            {options.map((o) => (
              <label key={o.key} className="flex items-center gap-2">
                <input type="checkbox" checked={ticked.includes(o.key)} onChange={(e) => setChosen(e.target.checked ? [...ticked, o.key] : ticked.filter((k) => k !== o.key))} /> {o.label}
                {o.hand && " (you post it yourself)"}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-1.5 text-sm font-medium">
            <Input label="First post" type="datetime-local" className="w-auto" value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
          <p className="text-sm text-muted-foreground">{`Each clip goes to one account. An account posts at most one clip a day, for a week${recordings.length ? ", skipping days it already posts a clip from this step" : ""}.`}</p>
          <Button type="submit" size="sm" variant={recordings.length ? "outline" : "default"} className="self-start" disabled={!source || !picked.length || !when} pending={starting.pending}>
            Make clips
          </Button>
        </form>
      )}
    </section>
  );
}
