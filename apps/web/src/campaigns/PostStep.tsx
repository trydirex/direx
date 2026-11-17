// SPDX-License-Identifier: AGPL-3.0-only
// A social post step: the drafted posts first, each as a card on its network to approve or edit, then the
// composer to write more. A Network that can't publish here offers copy and paste, and nothing on this
// screen says Direx posted that.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { EmptyState, Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Input, Textarea } from "@/components/Input";
import { useAction } from "../components/useAction";
import { approve, approveClean, detail, ITEM_MESSAGES, message, type BulkResult, type ItemState } from "../items/actions";
import { Content, PostEditor } from "../items/ItemPanel";
import { Rewrite } from "../items/Rewrite";
import { StateChip } from "../items/StateChip";
import { ChannelMark, channelOf } from "../components/ChannelMark";
import { DraftProgress } from "../plans/Fields";
import { RememberThis } from "../lessons/RememberThis";
import { accounts as loadAccounts, draftPosts, editPost, markPosted, megabytes, networks as loadNetworks, postStatus, postsOf, previewPost, sayFollowUp, sayPost, uploadImage, uploadVideo, videoUrl, type Account, type Network, type Post, type PostTarget, type Preview, type Video } from "../social/actions";
import { momentWords, say, startStepDraft, type Step } from "./actions";

/** The first refusal from a bulk approve, or "failed" when the call answered nothing at all. */
export const refusedOf = (r: BulkResult) => r.refused[0]?.reason ?? (r.done ? null : "failed");

type Choice = { key: string; label: string; connection: string; credentialId: string | null; networkId: string | null; hand: boolean; followUps: boolean };

/** Connected accounts first, then every Network that can't publish here, offered by hand. */
export function choices(accounts: Account[], networks: Network[]): Choice[] {
  const publishes = new Set(networks.filter((n) => n.publishes).map((n) => n.connection));
  const fromAccounts = accounts.map((a) => ({
    key: `${a.credentialId}:${a.networkId}`,
    label: `${a.network}: ${a.name}`,
    connection: a.connection,
    credentialId: a.credentialId,
    networkId: a.networkId,
    hand: !publishes.has(a.connection),
    followUps: a.canDo.some((c) => c.feature === "follow_ups" && c.status === "available"),
  }));
  const connected = new Set(accounts.map((a) => a.connection));
  const byHand = networks.filter((n) => !n.publishes && !connected.has(n.connection)).map((n) => ({ key: n.connection, label: n.label, connection: n.connection, credentialId: null, networkId: null, hand: true, followUps: false }));
  return [...fromAccounts, ...byHand];
}

/** A post's text with a link in it gets its link card from the Item, as Review shows it. */
const hasLink = (text: string) => /https?:\/\//.test(text);
type Appearance = NonNullable<Awaited<ReturnType<typeof detail>>>["appearance"];

/** `quiet` when an Approve all above is the step's one primary button. */
export function PostRow(p: { workspaceId: string; post: Post; approve: boolean; edit?: boolean; quiet?: boolean; onChange: () => void }) {
  const { post } = p;
  const [link, setLink] = useState("");
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const approving = useAction();
  const marking = useAction();
  const saving = useAction();
  const [appearance, setAppearance] = useState<Appearance>(null);
  useEffect(() => {
    if (hasLink(post.text)) void detail(p.workspaceId, post.itemId).then((d) => setAppearance(d?.appearance ?? null));
  }, [p.workspaceId, post.itemId, post.text]);
  const shown = appearance?.kind === "post" ? appearance : { kind: "post" as const, account: post.accountName, network: post.network, link: null };
  // A picture with no alt text written says its file name, so a screen reader says something.
  const content = { text: post.text, video: post.video, images: post.images.map((img) => ({ ...img, alt: img.alt || (img.fileName ?? "") })) };
  const waiting = post.state === "needs_approval";
  const editable = p.edit && (post.state === "draft" || waiting || post.state === "scheduled") && !post.clipId;
  // The Social agent rewrites a post waiting for approval as asked; it lands as a new version that waits again.
  const rewritable = editable && waiting;
  const save = (text: string, andApprove: boolean) =>
    void saving.run(async () => {
      const failed = await editPost(p.workspaceId, post.itemId, text);
      // Approving after an edit approves the saved version, read back, and only when it has no warnings to read.
      const fresh = !failed && andApprove ? (await detail(p.workspaceId, post.itemId))?.item : undefined;
      const refused = fresh?.state === "needs_approval" && fresh.clean ? await approve(p.workspaceId, fresh) : null;
      setError(failed ?? (refused ? message(refused) : undefined));
      if (!failed) setEditing(false);
      p.onChange();
      return null;
    });
  return (
    <li className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0 first:pt-0">
      <p className="flex flex-wrap items-center gap-2">
        <ChannelMark channel={channelOf(post.connection)} />
        <StateChip state={post.state as ItemState} reason={post.reason} />
        {post.at && <small className="text-sm text-muted-foreground">{momentWords(post.at)}</small>}
      </p>
      {post.mode === "manual" && <p className="text-sm text-muted-foreground">{postStatus(post)}</p>}
      {editing ? (
        <PostEditor text={post.text} network={post.network} approve={p.approve && waiting} pending={saving.pending} onSave={save} onCancel={() => setEditing(false)} />
      ) : (
        <Content content={content} appearance={shown} linkImage={`/api/w/${p.workspaceId}/social/posts/${post.itemId}/link-image`} mediaUrl={(m) => videoUrl(p.workspaceId, m)} />
      )}
      {post.warnings.map((w) => <p key={w.text} role="note" className="text-sm text-muted-foreground">{w.text}</p>)}
      {post.followUps.map((f, i) => <p key={i}>{sayFollowUp(f.status, i + 1)}</p>)}
      {post.url && <a href={post.url} rel="noreferrer" target="_blank">Open the post</a>}
      {error && <Notice tone="error">{error}</Notice>}
      {!editing && ((p.approve && waiting) || editable) && (
        <div className="flex flex-wrap gap-2">
      {p.approve && waiting && (
        <Button
          type="button"
          size="sm"
          variant={p.quiet ? "outline" : "default"}
          pending={approving.pending}
          onClick={() =>
            void approving.run(async () => {
              const e = await approve(p.workspaceId, { id: post.itemId, revision: post.revision });
              setError(e ? message(e) : undefined);
              p.onChange();
              return null;
            })
          }
        >
          Approve
        </Button>
      )}
      {editable && (
        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
          Edit text
        </Button>
      )}
      {rewritable && (
        <Button type="button" size="sm" variant="outline" aria-expanded={asking} onClick={() => setAsking(!asking)}>
          Request changes
        </Button>
      )}
        </div>
      )}
      {!editing && asking && rewritable && (
        <Rewrite
          workspaceId={p.workspaceId}
          id={post.itemId}
          revision={post.revision}
          noun="post"
          onDone={() => {
            setAsking(false);
            p.onChange();
          }}
        />
      )}
      {post.mode === "manual" && post.state === "scheduled" && (
        <div className="flex flex-wrap items-end gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(post.text)}>Copy text</Button>{" "}
          {post.video && (
            <>
              <a href={videoUrl(p.workspaceId, post.video.mediaId)} download={post.video.fileName ?? "video"}>
                Download video
              </a>{" "}
            </>
          )}
          {(post.images ?? []).map((img, n) => (
            <a key={img.mediaId} href={videoUrl(p.workspaceId, img.mediaId)} download={img.fileName ?? `image-${n + 1}`}>
              {(post.images ?? []).length === 1 ? "Download image" : `Download image ${n + 1}`}
            </a>
          ))}
          {p.approve && (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                await marking.run(async () => {
                  const done = await markPosted(p.workspaceId, post.itemId, link.trim() || null);
                  setError(done ? undefined : "That link didn't save. Check it and try again.");
                  p.onChange();
                  return null;
                });
              }}
            >
              <div className="flex flex-col gap-1.5 text-sm font-medium">
                <Input label="Link to your post (optional)" type="url" value={link} onChange={(e) => setLink(e.target.value)} />
              </div>
              <Button type="submit" size="sm" pending={marking.pending}>Mark as posted by you</Button>
            </form>
          )}
        </div>
      )}
    </li>
  );
}

export function PostStep(p: { workspaceId: string; id: string; step: Step; edit: boolean; approve: boolean; onChange?: () => void; initial?: { accounts: Account[]; networks: Network[]; posts: Post[] } }) {
  const { workspaceId, id, step } = p;
  const [accounts, setAccounts] = useState(p.initial?.accounts ?? []);
  const [networks, setNetworks] = useState(p.initial?.networks ?? []);
  const [posts, setPosts] = useState(p.initial?.posts ?? []);
  const [chosen, setChosen] = useState<string[]>([]);
  const [perAccount, setPerAccount] = useState(false);
  const [text, setText] = useState(step.template?.text ?? "");
  const [runId, setRunId] = useState<string>();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [followUp, setFollowUp] = useState("");
  const [when, setWhen] = useState(step.on ? `${step.on}T09:00` : "");
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const [written, setWritten] = useState(false);
  const [video, setVideo] = useState<Video | null>(null);
  /** Up to 4 images, in the order they show, each with what a screen reader says for it. */
  const [images, setImages] = useState<(Video & { alt: string })[]>([]);
  const [uploading, setUploading] = useState(false);
  const starting = useAction();
  const checking = useAction();
  const writing = useAction();
  const approvingAll = useAction(ITEM_MESSAGES);

  const reload = async () => setPosts(await postsOf(workspaceId, id, step.key));
  useEffect(() => {
    void (async () => {
      const [a, n] = await Promise.all([loadAccounts(workspaceId), loadNetworks(workspaceId)]);
      setAccounts(a);
      setNetworks(n);
      await reload();
    })();
  }, [workspaceId, id, step.key]);

  // What the Social agent wrote lands in the box, to read and change before any draft exists.
  useEffect(() => setText((t) => t || step.template?.text || ""), [step.template?.text]);

  const options = choices(accounts, networks);
  const picked = options.filter((o) => chosen.includes(o.key));
  const targetOf = (o: Choice): PostTarget => ({
    connection: o.connection,
    credentialId: o.credentialId,
    networkId: o.networkId,
    text: perAccount ? (texts[o.key] ?? "") : text,
    ...(followUp.trim() && o.followUps && { followUps: [followUp.trim()] }),
    ...(video && { mediaId: video.id }),
    ...(images.length > 0 && { mediaIds: images.map((i) => i.id), alt: images.map((i) => i.alt.trim()) }),
  });
  const clean = posts.filter((x) => x.state === "needs_approval" && x.clean);

  return (
    <section aria-label={`Posts for ${step.title ?? step.key}`} className="flex flex-col gap-4">
      {p.approve && clean.length > 1 && (
        <Button
          type="button"
          size="sm"
          className="self-start"
          pending={approvingAll.pending}
          onClick={() =>
            void approvingAll.run(async () => {
              const r = await approveClean(workspaceId, clean.map((x) => ({ id: x.itemId, revision: x.revision })));
              await reload();
              return refusedOf(r);
            })
          }
        >
          Approve all {clean.length} without warnings
        </Button>
      )}
      {approvingAll.error && <Notice tone="error">{approvingAll.error}</Notice>}
      <ul className="flex flex-col">
        {posts.map((post) => <PostRow key={post.id} workspaceId={workspaceId} post={post} approve={p.approve} edit={p.edit} quiet={p.approve && clean.length > 1} onChange={() => void reload()} />)}
      </ul>
      {p.edit && posts.length > 0 && <h4 className="font-medium">Write more posts</h4>}
      {p.edit && (
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            // A post with no words is refused by every network, so it is caught here, naming where it's missing.
            const empty = picked.filter((o) => !targetOf(o).text.trim());
            if (empty.length) return setProblems([perAccount ? `Write the text for ${empty.map((o) => o.label).join(", ")} first.` : "Write the post's text first."]);
            await writing.run(async () => {
              const results = await draftPosts(workspaceId, id, step.key, new Date(when).toISOString(), picked.map(targetOf));
              setProblems(results ? results.filter((r) => !r.ok).map((r) => `${r.connection}: ${sayPost(r)}`) : ["That didn't go through. Try again."]);
              setWritten(!!results?.some((r) => r.ok));
              await reload();
              return null;
            });
          }}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Where it goes</legend>
            {options.map((o) => (
              <label key={o.key} className="flex items-center gap-2">
                <input type="checkbox" checked={chosen.includes(o.key)} onChange={(e) => setChosen(e.target.checked ? [...chosen, o.key] : chosen.filter((k) => k !== o.key))} /> {o.label}
                {o.hand && <small className="text-sm text-muted-foreground"> (copy and paste: you post this yourself)</small>}
              </label>
            ))}
            {options.length === 0 && (
              <EmptyState
                title="No networks yet"
                action={
                  <Link to="/w/$workspaceId/settings/social" params={{ workspaceId }}>
                    Connect an account
                  </Link>
                }
              >
                Accounts you connect under Social show here.
              </EmptyState>
            )}
          </fieldset>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={perAccount} onChange={(e) => setPerAccount(e.target.checked)} /> Write a version for each account
          </label>
          {runId ? (
            <DraftProgress
              workspaceId={workspaceId}
              runId={runId}
              onDone={() => {
                setRunId(undefined);
                p.onChange?.();
              }}
            />
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              pending={starting.pending}
              onClick={() =>
                void starting.run(async () => {
                  const r = await startStepDraft(workspaceId, id, step.key);
                  if ("error" in r) setProblems([say(r.error)]);
                  else setRunId(r.runId);
                  return null;
                })
              }
            >
              Write it for me
            </Button>
          )}
          {step.template?.warnings?.map((w) => <p key={w.text} role="note" className="text-sm text-muted-foreground">{w.text}</p>)}
          {!perAccount && (
            <div className="flex flex-col gap-1.5 text-sm font-medium">
              <Textarea label="Text" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
            </div>
          )}
          {perAccount &&
            picked.map((o) => (
              <div key={o.key} className="flex flex-col gap-1.5 text-sm font-medium">
                <Textarea label={o.label} rows={4} value={texts[o.key] ?? ""} onChange={(e) => setTexts({ ...texts, [o.key]: e.target.value })} />
              </div>
            ))}
          {picked.some((o) => o.followUps) && (
            <div className="flex flex-col gap-1.5 text-sm font-medium">
              <Textarea label="Follow-up comment (optional), on the accounts that can take one" rows={2} value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
            </div>
          )}
          {/* A post carries a video or images, so each choice hides the other until it's removed. */}
          {!video && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">Images (optional, up to 4)</legend>
              {images.length > 0 && (
                <ol className="flex flex-col gap-3">
                  {images.map((img, n) => (
                    <li key={img.id} className="flex flex-wrap items-end gap-3">
                      <img src={videoUrl(workspaceId, img.id)} alt="" className="size-16 rounded-control object-cover" />
                      <div className="flex min-w-48 flex-1 flex-col gap-1.5 text-sm font-medium">
                        <Input
                          label={`Describe ${img.fileName} for people who can't see it`}
                          maxLength={1000}
                          value={img.alt}
                          onChange={(e) => {
                            setImages(images.map((x, i) => (i === n ? { ...x, alt: e.target.value } : x)));
                            setPreviews({});
                          }}
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setImages(images.filter((_, i) => i !== n));
                          setPreviews({});
                        }}
                      >
                        Remove {img.fileName}
                      </Button>
                    </li>
                  ))}
                </ol>
              )}
              {images.length < 4 && (
                <div className="flex flex-col gap-1.5 text-sm font-medium">
                  <Input
                    label={images.length ? "Add another image" : "Add an image"}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    disabled={uploading}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setUploading(true);
                      const r = await uploadImage(workspaceId, file);
                      setUploading(false);
                      if ("image" in r) {
                        setImages([...images, { ...r.image, alt: "" }]);
                        setPreviews({});
                      } else setProblems([r.error]);
                    }}
                  />
                  {uploading && <small className="font-normal text-muted-foreground"> Uploading…</small>}
                </div>
              )}
            </fieldset>
          )}
          {images.length === 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Video (optional)</legend>
            {video ? (
              <p>
                {video.fileName}, {megabytes(video.bytes)}{" "}
                <Button type="button" size="sm" variant="outline" onClick={() => setVideo(null)}>
                  Remove video
                </Button>
              </p>
            ) : (
              <div className="flex flex-col gap-1.5 text-sm font-medium">
                <Input
                  label="Add video"
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  disabled={uploading}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setUploading(true);
                    const r = await uploadVideo(workspaceId, file);
                    setUploading(false);
                    if ("video" in r) {
                      setVideo(r.video);
                      setPreviews({});
                    } else setProblems([r.error]);
                  }}
                />
                {uploading && <small className="font-normal text-muted-foreground"> Uploading…</small>}
              </div>
            )}
          </fieldset>
          )}
          <div className="flex flex-col gap-1.5 text-sm font-medium">
            <Input label="When" type="datetime-local" className="w-auto" required value={when} onChange={(e) => setWhen(e.target.value)} />
          </div>
          {picked.map((o) => {
            const v = previews[o.key];
            if (!v) return null;
            return (
              <p key={o.key}>
                {o.label}: {v.ok ? (v.count ? `${v.count.used} of ${v.count.limit}` : "ready") : sayPost(v)}
                {v.ok && video && (v.mode === "manual" ? " You post this video yourself." : " Direx posts it with the video.")}
                {v.ok && images.length > 0 && (v.mode === "manual" ? ` You post ${images.length === 1 ? "this image" : "these images"} yourself.` : ` Direx posts it with ${images.length === 1 ? "the image" : "the images"}.`)}
                {v.ok && v.text !== targetOf(o).text && <> It will read: {v.text}</>}
              </p>
            );
          })}
          <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            pending={checking.pending}
            onClick={() =>
              void checking.run(async () => {
                const entries = await Promise.all(picked.map(async (o) => [o.key, await previewPost(workspaceId, targetOf(o))] as const));
                setPreviews(Object.fromEntries(entries));
                return null;
              })
            }
          >
            Check against each network
          </Button>{" "}
          <Button type="submit" size="sm" variant={posts.length ? "outline" : "default"} disabled={!picked.length || !when} pending={writing.pending}>Save as drafts</Button>
          </div>
          {problems.map((m) => <Notice key={m} tone="error">{m}</Notice>)}
        </form>
      )}
      {/* Outside the drafts form: a form inside it would submit both. */}
      {p.edit && written && <RememberThis workspaceId={workspaceId} agent="social_drafter" sourceRef={`campaign:${id}/${step.key}`} />}
    </section>
  );
}
