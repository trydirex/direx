// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError, inWorkspace } from "../api/query";
import { planQuery } from "../plans/actions";
import { Field, Notice } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button, Key } from "@/components/Button";
import { Drawer } from "@astryxdesign/core/Drawer";
import { Input, Textarea } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { addDays, approve, approveLabel, cancel, type detail, itemQuery, ITEM_MESSAGES, mayApprove, mayEdit, mayWithdraw, message, move, resolveUnknown, resume, STATE_LABEL, type Item, type Reply, type Role } from "./actions";
import { CompanyReview, PageLink } from "../prospecting/CompanyReview";
import { SIGNAL_WORDS, type Review } from "../prospecting/actions";
import { addHold, eligibility, personHolds, recordWords, releaseHold, warningWords, type EligibilityRecord } from "../outreach/actions";
import { ReplyItem, ReplyReview, type ReplyContent } from "./ReplyReview";
import { Rewrite } from "./Rewrite";
import { StateChip } from "./StateChip";
import { WrittenFrom } from "./WrittenFrom";
import { AskAbout } from "../ask/Panel";
import { BriefView, type BriefContent } from "../seo/BriefView";
import { CounterMoveView, type CounterMoveContent } from "../facts/CounterMove";
import { ProposalView } from "../lessons/ProposalView";
import { membersQuery } from "../identity/actions";
import { isTokenActor, useTokenWords } from "./token-actor";
import { meQuery } from "../shell/session";
import { AGENT_NAMES } from "../models/actions";
import { FIELD_LABEL, type Field as FactField } from "../facts/actions";
import { editPersonDraft, resolveStall, say } from "../campaigns/actions";
import { editPost } from "../social/actions";
import { PlanChangeChoice, PlanImpact } from "../campaigns/PlanChange";
import { AssumptionsChoice } from "../campaigns/WriteUp";
import { ago } from "@/lib/ago";
import { toast } from "@/components/toast";
import type { components } from "../api/schema";

type Detail = NonNullable<Awaited<ReturnType<typeof detail>>>;
/** For a datetime-local input, in the browser's timezone. */
const localInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** Beside an email's text: how its address was found and its company's signals, all as text from the company's pages. */
function RecipientNotes({ notes }: { notes: NonNullable<Detail["recipient"]> }) {
  return (
    <section aria-label="About the recipient">
      {notes.roleAddress && <p>Role address: it reaches a team, not one person.</p>}
      {notes.guessedAddress && <p>Guessed address: not published, found by a check that it is deliverable.</p>}
      {notes.signals.length > 0 && (
        <ul aria-label="Signals">
          {notes.signals.map((s, n) => (
            <li key={n}>
              {SIGNAL_WORDS[s.type] ?? s.type}, {s.observedOn}: <q>{s.quote}</q> <PageLink url={s.pageUrl}>on this page</PageLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Beside an email to one Person: why they may be contacted, and what country research suggests checking first. */
export function BasisNotes(p: { workspaceId: string; personId: string; initial?: EligibilityRecord | null }) {
  const [record, setRecord] = useState(p.initial);
  useEffect(() => {
    if (p.initial === undefined) void eligibility(p.workspaceId, p.personId).then(setRecord);
  }, [p.workspaceId, p.personId]);
  if (record === undefined) return null;
  return (
    <section aria-label="Why they may be contacted">
      <p>{record ? recordWords(record) : "No reason recorded"}</p>
      {record && record.warnings.length > 0 && (
        <ul>
          {warningWords(record).map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

const ACTOR_WORDS: Record<"person" | "agent" | "system", string> = { person: "a person", agent: "Direx", system: "Direx" };

type Recipient = string | { name: string; address: string };
type Email = { to: Recipient[]; cc?: Recipient[]; subject: string; text: string };
const isEmail = (c: unknown): c is Email => {
  const e = c as Partial<Email> | null;
  return !!e && Array.isArray(e.to) && typeof e.subject === "string" && typeof e.text === "string";
};
const line = (term: string, value: ReactNode) => (
  <div className="flex gap-3">
    <dt className="w-16 shrink-0 text-muted-foreground">{term}</dt>
    <dd className="min-w-0 wrap-break-word">{value}</dd>
  </div>
);
type FactContent = { field: FactField; value: string; subject?: string; source?: { label?: string } };
/** A suggested or conflicting Brand Fact: a field Brand knows and its value. */
const isFact = (c: unknown): c is FactContent => {
  const f = c as Partial<FactContent> | null;
  return !!f && typeof f.field === "string" && f.field in FIELD_LABEL && typeof f.value === "string";
};
/** How the Item shows as what it will be, from the API: an email's Mailbox, a post's account and network. */
type Appearance = components["schemas"]["ItemAppearance"];
type Post = {
  text: string;
  followUps?: string[];
  video?: { fileName?: string };
  /** A hand post's images, with their names and alt text. */
  images?: { mediaId: string; fileName?: string; alt?: string }[];
  /** A published post's files and the alt text of its images. */
  media?: { mediaId: string; contentType: string }[];
  alt?: string[];
};
/** A post's images in order, from a hand post's payload or a published post's spec. */
const picturesOf = (p: Post) => p.images ?? (p.media ?? []).filter((m) => m.contentType.startsWith("image/")).map((m, i) => ({ mediaId: m.mediaId, alt: p.alt?.[i] ?? "" }));
const isPost = (c: unknown): c is Post => {
  const p = c as Partial<Post> | null;
  return !!p && typeof p.text === "string" && (p.followUps === undefined || Array.isArray(p.followUps));
};
type Span = { text: string; kind: "same" | "added" };
/**
 * The text with what was written for this person marked and the step's own words dimmed. The spans
 * cover the text before its footer; when they don't match the start of the text, it shows unmarked.
 */
export function marked(text: string, spans?: Span[] | null): ReactNode {
  const compared = spans?.map((s) => s.text).join("");
  if (!spans?.length || !compared || !text.startsWith(compared)) return text;
  return (
    <>
      <span className="sr-only">Marked: written for this person. The rest is the step&apos;s email.</span>
      {spans.map((s, n) => (s.kind === "added" ? <mark key={n}>{s.text}</mark> : <span key={n} className="text-muted-foreground">{s.text}</span>))}
      <span className="text-muted-foreground">{text.slice(compared.length)}</span>
    </>
  );
}

/** A recipient detail's quote and the page it came from, as the writer recorded it. */
const sourceOf = (w: { code?: string; text: string }) => (w.code === "recipient_detail" ? /^Says about them: "([\s\S]*)" \(from (.*)\)$/.exec(w.text) : null);

const addressLine = (rs: Recipient[]) => rs.map((r) => (typeof r === "string" ? r : `${r.name} <${r.address}>`)).join(", ");

/**
 * What an Item will do. An email reads as an email: the Mailbox it goes from, who it goes to, its
 * subject, then the exact text with its footer. Only the text is shown, never HTML. A post reads as a
 * post on its network: the account it goes out as, its text and its follow-ups. Anything else, and the
 * raw form of either, is the stored content as it is.
 */
// ponytail: where the desktop feed folds a post, roughly (LinkedIn about 210, an Instagram caption about 125); add a network when we know its fold.
const FEED_FOLD: Record<string, number> = { LinkedIn: 210, "LinkedIn Pages": 210, Instagram: 125 };
// ponytail: counted in code points; X weighs links and some scripts differently, so near its limit the network's own count wins.
/** Each network's post length limit, by the label the API names it with. */
export const POST_LIMIT: Record<string, number> = { LinkedIn: 3000, "LinkedIn Pages": 3000, X: 280, Threads: 500, Instagram: 2200, Bluesky: 300 };

/** A post's length against its network's limit, in red when it is over. Nothing for a network with no known limit. */
export function PostCount(p: { network: string; text: string }) {
  const limit = POST_LIMIT[p.network];
  if (!limit) return null;
  const used = [...p.text].length;
  const over = used - limit;
  return (
    <p className={`text-xs tabular-nums ${over > 0 ? "text-destructive" : "text-muted-foreground"}`}>
      {over > 0 ? `${used} of ${limit} characters: ${over} over the ${p.network} limit` : `${used} of ${limit} characters`}
    </p>
  );
}

/** A post's text folded where its network's feed folds it, so the reviewer sees what shows before "see more". */
export function FeedText(p: { network: string; text: string }) {
  const [open, setOpen] = useState(false);
  const fold = FEED_FOLD[p.network];
  if (open || !fold || p.text.length <= fold) return <p className="wrap-break-word whitespace-pre-wrap">{p.text}</p>;
  return (
    <p className="wrap-break-word whitespace-pre-wrap">
      {p.text.slice(0, fold).trimEnd()}…{" "}
      <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-muted-foreground underline underline-offset-4" onClick={() => setOpen(true)}>
        see more
      </button>
    </p>
  );
}

/** `linkImage` is where Direx serves the picture of a post's link card, when it has one. */
export function Content({ content, appearance, linkImage, mediaUrl, spans, showRaw }: { content: unknown; appearance?: Appearance | null; linkImage?: string; mediaUrl?: (mediaId: string) => string;
  /** An email's words compared with its step's email: what was written for this person is marked, the rest dimmed. */
  spans?: Span[] | null;
  /** The stored form under a Raw toggle, for owners and admins. */
  showRaw?: boolean }) {
  const raw = <pre className="rounded-card bg-background p-4 text-sm wrap-break-word whitespace-pre-wrap">{JSON.stringify(content, null, 2)}</pre>;
  const rawToggle = showRaw && (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">Raw</summary>
      {raw}
    </details>
  );
  if (isFact(content)) {
    return (
      <section aria-label="Proposed brand fact" className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
        <dl className="flex flex-col gap-1 text-sm">
          {line("Field", content.subject ? `${FIELD_LABEL[content.field]}: ${content.subject}` : FIELD_LABEL[content.field])}
          {line("Value", <span className="font-medium">{content.value}</span>)}
          {content.source?.label && line("From", content.source.label)}
        </dl>
        {rawToggle}
      </section>
    );
  }
  if (appearance?.kind === "post" && isPost(content)) {
    const name = appearance.account ?? "Your account";
    return (
      <section aria-label={`${appearance.network} post`} className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
        <header className="flex items-center gap-3">
          <span aria-hidden className="flex size-9 items-center justify-center rounded-full bg-muted font-medium">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span className="flex flex-col">
            <span className="font-medium">{name}</span>
            <span className="text-xs text-muted-foreground">{appearance.network}</span>
          </span>
        </header>
        <FeedText network={appearance.network} text={content.text} />
        <PostCount network={appearance.network} text={content.text} />
        {mediaUrl && picturesOf(content).length > 0 && (
          <div className={picturesOf(content).length > 1 ? "grid grid-cols-2 gap-1" : "flex"}>
            {picturesOf(content).map((pic) => (
              <img key={pic.mediaId} src={mediaUrl(pic.mediaId)} alt={pic.alt ?? ""} className="aspect-video max-h-56 w-full rounded-control object-cover" />
            ))}
          </div>
        )}
        {/* The first link's card, as the network shows it under the text. Its picture comes from Direx, never the linked site. */}
        {appearance.link && (
          <a href={appearance.link.url} target="_blank" rel="noreferrer noopener" className="flex flex-col gap-0.5 overflow-hidden rounded-card border border-border bg-muted/40 no-underline">
            {appearance.link.image && linkImage && <img src={linkImage} alt="" loading="lazy" className="aspect-video max-h-56 w-full object-cover" />}
            <span className="flex flex-col gap-0.5 p-3">
            <span className="text-xs text-muted-foreground">{appearance.link.site}</span>
            {appearance.link.title && <span className="font-medium text-foreground">{appearance.link.title}</span>}
            {appearance.link.description && <span className="line-clamp-2 text-sm text-muted-foreground">{appearance.link.description}</span>}
            </span>
          </a>
        )}
        {content.video && <p className="text-sm text-muted-foreground">{`With a video${content.video.fileName ? `: ${content.video.fileName}` : ""}`}</p>}
        {(content.followUps ?? []).length > 0 && (
          <ol aria-label="Follow-up comments" className="flex flex-col gap-2 border-t border-border pt-3 text-sm">
            {content.followUps!.map((f, n) => (
              <li key={n} className="wrap-break-word whitespace-pre-wrap">
                {f}
              </li>
            ))}
          </ol>
        )}
        {rawToggle}
      </section>
    );
  }
  if (!isEmail(content)) return raw;
  return (
    <section aria-label="Email" className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
      {/* The row the recipient sees in their inbox list before opening it. */}
      <p aria-label="In the inbox" className="flex min-w-0 items-baseline gap-3 rounded-control bg-muted px-3 py-2 text-sm">
        {appearance?.kind === "email" && <span className="max-w-40 shrink-0 truncate font-medium">{appearance.from}</span>}
        <span className="min-w-0 truncate">
          <span className="font-medium">{content.subject}</span>
          <span className="text-muted-foreground"> {content.text.replace(/\s+/g, " ").trim().slice(0, 140)}</span>
        </span>
      </p>
      <dl className="flex flex-col gap-1 text-sm">
        {appearance?.kind === "email" && line("From", appearance.from)}
        {line("To", addressLine(content.to))}
        {content.cc && content.cc.length > 0 && line("Cc", addressLine(content.cc))}
        {line("Subject", <span className="font-medium">{content.subject}</span>)}
      </dl>
      <div className="border-t border-border pt-3 wrap-break-word whitespace-pre-wrap">{marked(content.text, spans)}</div>
      {rawToggle}
    </section>
  );
}

/** Where the server's footer starts, as Campaigns strips it: the person edits only their own words. */
const FOOTER = "\n\n--\n";
export const withoutFooter = (text: string) => (text.includes(FOOTER) ? text.slice(0, text.lastIndexOf(FOOTER)) : text);

/**
 * One email's subject and text, edited in place. Saving sends it back for approval; "Save and approve"
 * is this person's own approval of the words they just wrote. Escape cancels.
 */
export function EmailEditor(p: { email: Email; approve: boolean; pending: boolean; onSave: (body: { subject: string; text: string }, andApprove: boolean) => void; onCancel: () => void }) {
  const [subject, setSubject] = useState(p.email.subject);
  const [text, setText] = useState(() => withoutFooter(p.email.text));
  const ready = subject.trim() !== "" && text.trim() !== "";
  return (
    <form
      aria-label="Edit text"
      className="flex flex-col gap-3 rounded-card border border-border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) p.onSave({ subject, text }, false);
      }}
      onKeyDown={(e) => e.key === "Escape" && p.onCancel()}
    >
      <Field label="Subject">
        <Input value={subject} maxLength={200} required onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field label="Email" hint="The footer is added when it sends.">
        <Textarea autoFocus value={text} maxLength={5000} required rows={10} onChange={(e) => setText(e.target.value)} />
      </Field>
      <SaveButtons approve={p.approve} pending={p.pending} ready={ready} onApprove={() => p.onSave({ subject, text }, true)} onCancel={p.onCancel} />
    </form>
  );
}

function SaveButtons(p: { approve: boolean; pending: boolean; ready: boolean; onApprove: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {p.approve && (
        <Button type="button" pending={p.pending} disabled={!p.ready} onClick={p.onApprove}>
          Save and approve
        </Button>
      )}
      <Button type="submit" variant={p.approve ? "outline" : "default"} pending={p.pending} disabled={!p.ready}>
        Save
      </Button>
      <Button type="button" variant="ghost" disabled={p.pending} onClick={p.onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** A post's words in place, counted against its network's limit as they are typed. Follow-ups, video and images stay. */
export function PostEditor(p: { text: string; network: string; approve: boolean; pending: boolean; onSave: (text: string, andApprove: boolean) => void; onCancel: () => void }) {
  const [text, setText] = useState(p.text);
  const ready = text.trim() !== "";
  return (
    <form
      aria-label="Edit text"
      className="flex flex-col gap-3 rounded-card border border-border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) p.onSave(text, false);
      }}
      onKeyDown={(e) => e.key === "Escape" && p.onCancel()}
    >
      <Field label={`${p.network} post`}>
        <Textarea autoFocus value={text} required rows={8} onChange={(e) => setText(e.target.value)} />
      </Field>
      <PostCount network={p.network} text={text} />
      <SaveButtons approve={p.approve} pending={p.pending} ready={ready} onApprove={() => p.onSave(text, true)} onCancel={p.onCancel} />
    </form>
  );
}

/** The next step under a Held chip, for the hold reasons whose fix is known here. */
function HeldNext(p: { item: Item; workspaceId: string; edit: boolean; pending: boolean; onMove: (to: string) => void }) {
  const i = p.item;
  const campaignId = i.groupKey?.match(/^campaign:([^:]+)/)?.[1];
  const w = { workspaceId: p.workspaceId };
  const next =
    i.reasonCode === "account_budget_reached" && i.at && i.movable && p.edit ? (
      <>
        This account has posted all it can today.{" "}
        <Button size="xs" variant="outline" pending={p.pending} onClick={() => p.onMove(addDays(new Date(i.at!), 1).toISOString())}>
          Move it to tomorrow
        </Button>
      </>
    ) : i.reasonCode === "workspace_paused" ? (
      "Sending is paused. It goes once sending is turned back on."
    ) : i.reasonCode === "campaign_paused" && campaignId ? (
      <>
        Its Campaign is paused.{" "}
        <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ ...w, campaignId }}>
          Resume the Campaign
        </Link>
      </>
    ) : i.reasonCode === "mailbox_paused" ? (
      <>
        Its email account is paused.{" "}
        <Link to="/w/$workspaceId/settings/credentials" params={w}>
          See why
        </Link>
        . It goes once someone resumes the account.
      </>
    ) : i.reasonCode === "mailbox_unchecked" ? (
      <>
        Its Mailbox hasn't passed its check.{" "}
        <Link to="/w/$workspaceId/settings/credentials" params={w}>
          Run the check
        </Link>
        , then it resumes on its own.
      </>
    ) : null;
  return next && <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">{next}</p>;
}

/** One Item's panel over the page it was opened from: focus moves in, Escape closes, focus goes back. */
export function ItemDialog(p: { workspaceId: string; id?: string; role: Role; onClose: () => void }) {
  const title = useQuery({ ...itemQuery(p.workspaceId, p.id ?? ""), enabled: p.id !== undefined }).data?.item.title;
  return (
    <Drawer isOpen={p.id !== undefined} onOpenChange={(open) => !open && p.onClose()} label={title ?? "Details"} side="end" width={480} experimental={{ isFullWidthOnMobile: true }}>
      {p.id && <ItemPanel workspaceId={p.workspaceId} id={p.id} role={p.role} onClose={p.onClose} />}
    </Drawer>
  );
}

/** Kinds whose content only points at other records (a plan, a Campaign): the title says what happened and the links below go there, so the panel shows no body. */
const POINTERS: ReadonlySet<string> = new Set(["plan_change", "plan_version", "strategy_version", "next_step", "campaign_launch_moved", "campaign_waiting", "campaign_stall"]);

/**
 * One Item's content, state, history and what can be done with it. Every change refreshes the
 * Workspace's queries. With `keys`, the plain approve button carries the A shortcut for Review.
 */
export function ItemPanel(p: { workspaceId: string; id: string; role: Role; onChange?: () => void; onClose?: () => void; keys?: boolean;
  /** Review's controls. With them, the approve button leads one bar that stays at the top while the content scrolls. */
  toolbar?: ReactNode;
  initial?: Detail & { reply?: Reply; basis?: EligibilityRecord | null } }) {
  const client = useQueryClient();
  const query = useQuery({ ...itemQuery(p.workspaceId, p.id), initialData: p.initial });
  // Names for History: who did each step, rather than only what kind of actor it was.
  const members = useQuery(membersQuery(p.workspaceId)).data;
  const me = useQuery(meQuery).data;
  const tokenWords = useTokenWords(p.workspaceId, (query.data?.timeline ?? []).map((e) => e.actor));
  const who = (a: { kind: "person" | "agent" | "system"; id: string }) =>
    (a.kind === "person" && (members?.find((m) => m.userId === a.id)?.name || members?.find((m) => m.userId === a.id)?.email)) || (a.kind === "agent" && AGENT_NAMES[a.id]) || (isTokenActor(a) && tokenWords(a.id)) || ACTOR_WORDS[a.kind];
  const [error, setError] = useState<string>();
  // What the person typed, until a change reloads the Item's own time.
  const [typed, setTyped] = useState<string>();
  // One change at a time: every button waits while one runs.
  const [pending, setPending] = useState(false);
  // When this Item was opened, sent with the decision so the reviewer's pace can be measured.
  const [opened] = useState(() => new Date().toISOString());
  const [praise, setPraise] = useState(false);
  // The email's words open in place for editing.
  const [editing, setEditing] = useState(false);
  // The send time field, which the bar's Move goes to.
  const moveAt = useRef<HTMLDivElement>(null);

  async function settle(code: string | null) {
    setError(code ? message(code) : undefined);
    setTyped(undefined);
    await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
    p.onChange?.();
  }
  async function act(action: () => Promise<unknown>) {
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  }
  const d = query.data;
  if (d === undefined) {
    return (
      <QueryBoundary query={query} skeleton={<Skeleton className="h-64 w-full" />} messages={ITEM_MESSAGES}>
        {() => null}
      </QueryBoundary>
    );
  }
  /** A stalled step's other answers go through its Campaign, which can cancel what the step already made. */
  async function answerStall(choice: "go_ahead" | "cancel") {
    const c = d!.content as { campaignId: string; stepKey: string };
    const failed = await resolveStall(p.workspaceId, c.campaignId, c.stepKey, choice);
    await settle(null);
    setError(failed ? say(failed) : undefined);
  }
  const i: Item = d.item;
  const time = typed ?? localInput(i.at);
  const unknown = i.reasonCode === "outcome_unknown";
  const dismissOnly = i.kind !== "action";
  const touch = i.kind === "action" ? (d.content as { touch?: { personId?: unknown; touchClass?: unknown } } | null)?.touch : undefined;
  const personId = touch?.personId;
  const cold = touch?.touchClass === "cold" && typeof personId === "string";

  // The hold stops the Person's campaigns; this Item is cancelled too, in case it came from elsewhere.
  async function skipTalking() {
    const error = await addHold(p.workspaceId, personId as string, "Skipped on approval");
    if (!error) await cancel(p.workspaceId, i.id);
    await settle(error);
  }
  async function releaseGuess() {
    const kind = (await personHolds(p.workspaceId, personId as string))?.hold?.release;
    await settle(kind ? await releaseHold(p.workspaceId, personId as string, kind) : null);
  }
  // A newsletter issue may be handed to its tool early; the button names when readers get it.
  const issueAt = i.workArea === "newsletter" ? (d.content as { at?: unknown } | null)?.at : undefined;
  const sendsAt = typeof issueAt === "string" ? issueAt : i.at;

  async function moveTo(plannedAt = new Date(time).toISOString()) {
    const r = await move(p.workspaceId, [{ id: i.id, plannedAt }]);
    await settle(r.refused[0]?.reason ?? null);
  }

  // A Campaign's email to one Person: its words can be edited, which sends it back for approval.
  const step = i.groupKey?.match(/^campaign:([^:]+):step:(.+)$/);
  const textEditable = i.kind === "action" && i.workArea === "outreach" && isEmail(d.content) && !!step && typeof personId === "string" && (i.state === "draft" || i.state === "needs_approval" || i.state === "scheduled") && mayEdit(p.role);
  // A post's words can be edited the same way, wherever it came from.
  const post = d.appearance?.kind === "post" && isPost(d.content) ? { network: d.appearance.network, text: d.content.text } : null;
  const postEditable = !!post && i.workArea === "social" && (i.state === "draft" || i.state === "needs_approval" || i.state === "scheduled") && mayEdit(p.role);
  async function saveText(body: { subject: string; text: string }, andApprove: boolean) {
    const failed = await editPersonDraft(p.workspaceId, step![1]!, step![2]!, personId as string, body);
    await saved(failed && say(failed), andApprove);
  }
  /** After an edit: it waits for approval again, or is approved as saved when asked and nothing new needs reading. */
  async function saved(failed: string | null, andApprove: boolean) {
    if (failed) return setError(failed);
    setEditing(false);
    if (!andApprove) {
      toast.add({ title: "Saved. It waits for approval again." });
      return settle(null);
    }
    // Approve the version just saved, read back from the server, and only when nothing new needs reading.
    const fresh = (await client.fetchQuery({ ...itemQuery(p.workspaceId, i.id), staleTime: 0 })).item;
    if (fresh.state !== "needs_approval" || !fresh.clean) {
      toast.add({ title: "Saved. Read its warnings, then approve." });
      return settle(null);
    }
    await settle(await approve(p.workspaceId, fresh, undefined, opened));
  }

  const w = { workspaceId: p.workspaceId };
  const campaign = () => ({ ...w, campaignId: (d.content as { campaignId: string }).campaignId });
  const plainApprove =
    i.state === "needs_approval" && i.kind !== "fact_conflict" && i.kind !== "opt_out_review" && i.kind !== "reply" && i.kind !== "company_review" && i.kind !== "standing_rule_offer" && i.kind !== "next_step" && i.kind !== "plan_change" && i.kind !== "strategy_assumptions" && mayApprove(p.role);

  const approveText = i.kind === "action" ? approveLabel([{ at: sendsAt }]) : i.kind === "brief" ? "I'll make this change" : i.kind === "competitor_move" ? "I've done this" : i.kind === "campaign_stall" ? "Keep waiting" : i.kind === "campaign_waiting" || i.kind === "campaign_launch_moved" ? "Got it" : i.kind === "keys_lost" ? "Resume them" : i.kind === "late_sends" ? "Send the emails" : "Accept";
  const approveButton = plainApprove && (
    <Button pending={pending} label={approveText} aria-keyshortcuts={p.keys ? "A" : undefined} onClick={() => void act(async () => settle(await approve(p.workspaceId, i, undefined, opened, praise)))}>
      {approveText}
      {p.keys && <Key>A</Key>}
    </Button>
  );

  const dontSend = mayWithdraw(i) && mayEdit(p.role) && (
    <Button pending={pending} variant="outline" onClick={() => void act(async () => settle(await cancel(p.workspaceId, i.id, opened)))}>
      {dismissOnly ? "Dismiss" : "Don't send"}
    </Button>
  );
  const movable = i.movable && i.kind === "action" && mayEdit(p.role);

  return (
    <article aria-label={i.title} className="flex flex-col gap-4">
      {/* Review's bar holds every decision about the open Item (yes, no, another time) beside the moves through the queue. */}
      {p.toolbar && (
        <div role="toolbar" aria-label="Review" className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background py-3">
          {approveButton}
          {dontSend}
          {movable && (
            <Button
              variant="outline"
              onClick={() => {
                moveAt.current?.scrollIntoView({ block: "center" });
                moveAt.current?.querySelector("input")?.focus();
              }}
            >
              Move
            </Button>
          )}
          {p.toolbar}
        </div>
      )}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="min-w-0 wrap-break-word">{i.title}</h2>
        {p.onClose && (
          <Button variant="outline" size="sm" onClick={p.onClose}>
            Close
          </Button>
        )}
      </header>
      <p>
        <StateChip state={i.state} reason={i.reason} />
      </p>
      {i.state === "held" && <HeldNext item={i} workspaceId={p.workspaceId} edit={mayEdit(p.role)} pending={pending} onMove={(to) => void act(() => moveTo(to))} />}
      {i.warnings.length > 0 && (
        <ul aria-label="Warnings" className="flex list-disc flex-col gap-1 pl-5">
          {i.warnings.map((w) => {
            const source = sourceOf(w);
            return (
              <li key={w.text}>
                {source ? (
                  <>
                    Says about them: <q>{source[1]}</q> <PageLink url={source[2]!}>on this page</PageLink>
                  </>
                ) : (
                  w.text
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {i.kind === "opt_out_review" ? (
        <ReplyReview key={i.state} workspaceId={p.workspaceId} signalId={(d.content as { signalId: string }).signalId} initial={p.initial?.reply} />
      ) : i.kind === "reply" ? (
        <ReplyItem workspaceId={p.workspaceId} content={d.content as ReplyContent} members={members} meId={me?.id} initial={p.initial?.reply} />
      ) : i.kind === "brief" ? (
        <BriefView c={d.content as BriefContent} workspaceId={p.workspaceId} />
      ) : i.kind === "competitor_move" ? (
        <CounterMoveView c={d.content as CounterMoveContent} />
      ) : i.kind === "lesson_proposal" || i.kind === "lesson_fact" ? (
        <ProposalView workspaceId={p.workspaceId} kind={i.kind} content={d.content} />
      ) : i.kind === "strategy_assumptions" ? (
        <AssumptionsChoice key={i.revision} workspaceId={p.workspaceId} item={i} suggestions={(d.content as { suggestions: ComponentProps<typeof AssumptionsChoice>["suggestions"] }).suggestions} approve={mayApprove(p.role)} onDone={() => void settle(null)} />
      ) : i.kind === "company_review" ? (
        <CompanyReview key={i.revision} workspaceId={p.workspaceId} item={i} review={d.content as Review} role={p.role} keys={p.keys} onSettle={() => void settle(null)} />
      ) : (
        <>
          {typeof personId === "string" && <BasisNotes workspaceId={p.workspaceId} personId={personId} initial={p.initial?.basis} />}
          {d.recipient && <RecipientNotes notes={d.recipient} />}
          {editing && textEditable ? (
            <EmailEditor email={d.content as Email} approve={mayApprove(p.role)} pending={pending} onSave={(body, andApprove) => void act(() => saveText(body, andApprove))} onCancel={() => setEditing(false)} />
          ) : editing && postEditable ? (
            <PostEditor text={post.text} network={post.network} approve={mayApprove(p.role)} pending={pending} onSave={(text, andApprove) => void act(async () => saved(await editPost(p.workspaceId, i.id, text), andApprove))} onCancel={() => setEditing(false)} />
          ) : (
            !POINTERS.has(i.kind) && <Content content={d.content} appearance={d.appearance} spans={d.recipient?.spans} showRaw={p.role === "owner" || p.role === "admin"} linkImage={`/api/w/${p.workspaceId}/social/posts/${i.id}/link-image`} mediaUrl={(m) => `/api/w/${p.workspaceId}/media/${m}`} />
          )}
          {d.writtenFrom && <WrittenFrom workspaceId={p.workspaceId} from={d.writtenFrom} stepLabel={i.groupLabel} />}
          {(textEditable || postEditable) && !editing && (
            // Review's Edit (E) opens this, found by its data attribute.
            <Button variant="outline" size="sm" className="self-start" data-edit-text onClick={() => setEditing(true)}>
              Edit text
            </Button>
          )}
          {/* Only an email written for one person has a writer that can rewrite it; a step's template email says where its words change. */}
          {!editing && d.recipient && (i.state === "draft" || i.state === "needs_approval") && mayEdit(p.role) &&
            (d.writtenFrom?.run?.agent === "recipient_writer" ? (
              <Rewrite workspaceId={p.workspaceId} id={i.id} revision={i.revision} opened={opened} />
            ) : (
              step && <p className="text-sm text-muted-foreground">This email comes from its step's text, so change that text on the Campaign to rewrite it.</p>
            ))}
          {/* "This one's great" is kept with the approval; nothing reads it yet. */}
          {!editing && d.recipient && plainApprove && (
            <Button type="button" size="xs" variant={praise ? "default" : "outline"} className="self-start rounded-full" aria-pressed={praise} onClick={() => setPraise(!praise)}>
              This one's great
            </Button>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {i.kind === "opt_out_review" && i.state === "needs_approval" && mayApprove(p.role) && (
          <>
            <Button pending={pending} size="sm" onClick={() => void act(async () => settle(await approve(p.workspaceId, i, "opted_out")))}>
              They asked to stop
            </Button>
            <Button pending={pending} size="sm" variant="outline" onClick={() => void act(async () => settle(await approve(p.workspaceId, i, "not_opt_out")))}>
              They didn't
            </Button>
          </>
        )}
        {i.kind === "reply" && i.state === "needs_approval" && mayApprove(p.role) && (
          <>
            <Button pending={pending} size="sm" variant="outline" onClick={() => void act(async () => settle(await approve(p.workspaceId, i, "no_answer")))}>
              No answer needed
            </Button>
            <Button pending={pending} size="sm" variant="outline" onClick={() => void act(async () => settle(await approve(p.workspaceId, i, "answered_elsewhere")))}>
              Answered elsewhere
            </Button>
          </>
        )}
        {i.kind === "fact_conflict" && i.state === "needs_approval" && (
          <Link to="/w/$workspaceId/brand" params={w}>
            Decide on Brand
          </Link>
        )}
        {i.kind === "standing_rule_offer" && i.state === "needs_approval" && (p.role === "owner" || p.role === "admin") && (
          <Link to="/w/$workspaceId/settings/rules" params={w} search={{ campaign: (d.content as { campaignId: string }).campaignId, step: (d.content as { stepKey: string }).stepKey }}>
            Open the form
          </Link>
        )}
        {i.kind === "next_step" && (
          <>
            {i.state === "needs_approval" && mayApprove(p.role) && (
              // Drafts are timed in the starter's own zone, as the Campaign page's button does.
              <Button pending={pending} size="sm" onClick={() => void act(async () => settle(await approve(p.workspaceId, i, (d.content as { link: string }).link !== "plan_to_templates" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined)))}>
                Start
              </Button>
            )}
            <Link to="/w/$workspaceId/campaigns/$campaignId" params={campaign()}>
              Open the Campaign
            </Link>
          </>
        )}
      </div>
      {i.kind === "plan_change" && i.state === "needs_approval" && (
        <>
          <PlanChangeChoice workspaceId={p.workspaceId} campaignId={(d.content as { campaignId: string }).campaignId} stepKey={(d.content as { stepKey: string }).stepKey} itemId={i.id} kinds={(d.content as { kinds: ("text" | "channel" | "removed")[] }).kinds} edit={mayEdit(p.role)} onDone={() => void settle(null)} />
          <Link to="/w/$workspaceId/campaigns/$campaignId" params={campaign()} search={{ tab: "drafts" }}>
            Read the change in the Campaign
          </Link>
        </>
      )}
      {(i.kind === "campaign_launch_moved" || i.kind === "campaign_waiting") && (
        <Link className="self-start" to="/w/$workspaceId/campaigns/$campaignId" params={campaign()}>
          Open the Campaign
        </Link>
      )}
      {i.kind === "strategy_version" && (
        <Link className="self-start" to="/w/$workspaceId/brand" params={w}>
          Read it on Brand
        </Link>
      )}
      {i.kind === "plan_version" && <PlanGone workspaceId={p.workspaceId} planId={(d.content as { targetId: string }).targetId} />}
      {i.kind === "plan_version" && <PlanImpact workspaceId={p.workspaceId} planId={(d.content as { targetId: string }).targetId} refresh={i.revision} />}
      {i.kind === "campaign_stall" && i.state === "needs_approval" && mayEdit(p.role) && (
        <div className="flex flex-wrap items-center gap-2">
          {(d.content as { choices: string[] }).choices.includes("go_ahead") && (
            <Button size="sm" variant="outline" pending={pending} onClick={() => void act(() => answerStall("go_ahead"))}>
              Go ahead without it
            </Button>
          )}
          <Button size="sm" variant="outline" pending={pending} onClick={() => void act(() => answerStall("cancel"))}>
            Cancel the step
          </Button>
          <Link to="/w/$workspaceId/campaigns/$campaignId" params={campaign()} search={{ tab: "drafts" }}>
            Open the Campaign
          </Link>
        </div>
      )}
      {i.state === "held" && unknown && mayApprove(p.role) && (
        <div className="flex flex-col gap-2">
          <p>We can't tell if this went out. Check the channel or your inbox, then pick one.</p>
          <div className="flex flex-wrap gap-2">
            <Button pending={pending} size="sm" variant="outline" onClick={() => void act(async () => settle(await resolveUnknown(p.workspaceId, i.id, "mark_sent")))}>
              Mark sent
            </Button>
            <Button pending={pending} size="sm" variant="outline" onClick={() => void act(async () => settle(await resolveUnknown(p.workspaceId, i.id, "resend")))}>
              Resend, accepting it may go out twice
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!p.toolbar && approveButton}
        <AskAbout id={i.id} title={i.title} />
        {cold && i.state === "needs_approval" && mayApprove(p.role) && (
          <Button variant="outline" pending={pending} onClick={() => void act(skipTalking)}>
            We're talking to them
          </Button>
        )}
        {cold && i.state === "held" && i.reasonCode === "may_be_talking" && mayApprove(p.role) && (
          <Button variant="outline" pending={pending} onClick={() => void act(releaseGuess)}>
            Stop holding
          </Button>
        )}
        {i.state === "held" && !unknown && mayApprove(p.role) && (
          <Button pending={pending} variant="outline" onClick={() => void act(async () => settle(await resume(p.workspaceId, i.id)))}>
            {i.reasonCode === "snapshot_changed" || i.reasonCode === "rule_needs_review" ? "Send back for approval" : "Check again and resume"}
          </Button>
        )}
        {i.reasonCode === "credential_unavailable" && (
          <Link to="/w/$workspaceId/settings/credentials" params={w}>
            Reconnect
          </Link>
        )}
        {!p.toolbar && dontSend}
      </div>

      {movable && (
        <div ref={moveAt} className="flex flex-wrap items-end gap-3">
          <Field label="Send at">
            <Input type="datetime-local" value={time} onChange={(e) => setTyped(e.target.value)} />
          </Field>
          <Button variant="outline" disabled={!time} pending={pending} onClick={() => void act(moveTo)}>
            Move
          </Button>
          {i.state === "scheduled" && <p className="w-full text-sm text-muted-foreground">Moving it brings it back for approval.</p>}
        </div>
      )}

      {d.ruleGrantedBy && (
        <p className="text-muted-foreground">
          Auto-approved by a rule {d.ruleGrantedBy} turned on.{d.ruleWrittenBy && ` Written by ${d.ruleWrittenBy}, and no one read it before it went.`}
        </p>
      )}

      <h3>History</h3>
      <ol className="flex flex-col gap-1 text-sm text-muted-foreground">
        {d.timeline.map((e, n) => (
          <li key={n}>
            <time dateTime={e.at} title={new Date(e.at).toLocaleString()}>
              {ago(e.at)}
            </time>
            : {STATE_LABEL[e.to]}
            {e.reason ? ` (${e.reason})` : ""}, by {e.actor.id === "standing_rule" ? "an auto-approve rule" : e.actor.id === "campaign_advance" ? "the Campaign's run setting" : who(e.actor)}
          </li>
        ))}
      </ol>
    </article>
  );
}

/** ADR 0023: a plan_version Item is kept after its draft is deleted, so the plan it names may be gone. */
export function usePlanGone(workspaceId: string, planId: string | undefined) {
  const { error } = useQuery({ ...planQuery(workspaceId, planId ?? ""), enabled: planId !== undefined });
  return error instanceof ApiError && error.status === 404;
}

/** "This draft was deleted." when the plan an Item names no longer exists, else nothing. */
function PlanGone(p: { workspaceId: string; planId: string }) {
  return usePlanGone(p.workspaceId, p.planId) ? <p role="note">This draft was deleted.</p> : null;
}
