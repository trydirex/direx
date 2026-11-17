// SPDX-License-Identifier: AGPL-3.0-only
// Ask Direx: one conversation, opened with Ctrl J (Cmd J on a Mac) on any screen, from the sidebar,
// from the box on Home, or from an Item. The panel shows only what the API stored: while a reply is
// being worked on it shows the step the run is on, never words it hasn't kept.
import { MessageSquareIcon } from "lucide-react";
import { RailTip, railButton } from "@/shell/RailTip";
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { inWorkspace } from "../api/query";
import { Button, buttonVariants } from "@/components/Button";
import { Drawer } from "@astryxdesign/core/Drawer";
import { Textarea } from "@/components/Input";
import { approve, itemQuery, mayApprove, mayEdit, message, type Role } from "../items/actions";
import { StateChip } from "../items/StateChip";
import { lineDiff } from "../campaigns/PlanChange";
import { ask, askQuery, AREAS, undo, type Area, type AskMessage, type Looking } from "./actions";

const kbd = "rounded-sm border border-current px-1 font-sans text-xs opacity-80";
/** Why an Undo didn't go, in the person's words; anything else reads as an approve refusal does. */
const NO_UNDO: Record<string, string> = {
  moved_since: "It has been moved since, so it stays where it is now.",
  old_time_passed: "Its old time has passed, so it can't move back.",
  edited_since: "It has been edited on Brand since, so it stays.",
  cant_move: "It can't move now, so it stays where it is.",
};
const REFUSED: Record<string, string> = { not_found: "That isn't in your queue any more, so Ask can't look at it." };
/** The longest message the API takes. */
const MAX_CHARS = 4000;
const TOO_LONG = "That message is too long for Ask. Keep it under 4,000 characters.";
/** Kinds with no outside effect, which may be approved right on their card. Anything else opens its review. */
const APPROVE_ON_CARD = new Set(["reschedule", "fact_proposal", "ask_start"]);
/** An Agent as the Glossary names it: Social, Outreach. */
const agentName = (a: string) => (a === "seo" ? "SEO" : a.charAt(0).toUpperCase() + a.slice(1));
/** How long a rewrite card keeps checking for the new version; one that never came stops asking. */
const REWRITE_WAIT_MS = 10 * 60_000;
type Words = { subject?: string | undefined; text: string };
const wordsOf = (t: string) => t.split(/\s+/).filter(Boolean);
/** An email's or a post's words from its Item content: a subject and a text, or a post's body. */
function wordsIn(content: unknown): Words | null {
  const c = content as { subject?: unknown; text?: unknown; body?: unknown } | null;
  const text = typeof c?.text === "string" ? c.text : typeof c?.body === "string" ? c.body : null;
  return text === null ? null : { subject: typeof c?.subject === "string" ? c.subject : undefined, text };
}

type About = { itemId: string; title: string };
type Send = (text: string, about?: { itemId?: string | undefined; agent?: Area | undefined; looking?: Looking | undefined }) => Promise<string | null>;
type AskApi = { workspaceId: string; open: (about?: About) => void; send: Send };
const AskContext = createContext<AskApi | null>(null);

/** Opens the panel, optionally about one Item. Outside a Workspace screen there is no panel, so it is null. */
export const useAsk = () => useContext(AskContext);

export function AskProvider(p: { workspaceId: string; role: Role; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [about, setAbout] = useState<About>();
  // Held here, not in the panel, so a refusal from the box on Home shows in the panel it opened.
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "j") return;
      e.preventDefault();
      setOpen(!openRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const send: Send = async (text, a = {}) => {
    // Known before asking, so a long paste gets a reason rather than the API's bare refusal.
    if (text.length > MAX_CHARS) return (setError(TOO_LONG), TOO_LONG);
    const refused = await ask(p.workspaceId, { text, ...(a.itemId && { itemId: a.itemId }), ...(a.agent && { agent: a.agent }), ...(a.looking && { looking: a.looking }) });
    await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId, "ask") });
    const said = refused && (REFUSED[refused] ?? "Ask couldn't answer that. Try rephrasing, or try again in a minute.");
    setError(said);
    return said;
  };
  const api: AskApi = {
    workspaceId: p.workspaceId,
    open: (a) => {
      setAbout(a);
      setOpen(true);
    },
    send,
  };

  return (
    <AskContext.Provider value={api}>
      {p.children}
      <Drawer isOpen={open} onOpenChange={setOpen} label="Ask Direx" side="end" width={480} experimental={{ isFullWidthOnMobile: true }}>
        <div className="flex h-full flex-col gap-4">
          {open && <Conversation workspaceId={p.workspaceId} role={p.role} about={about} onDropAbout={() => setAbout(undefined)} send={send} error={error} onClose={() => setOpen(false)} />}
        </div>
      </Drawer>
    </AskContext.Provider>
  );
}

/** Three things to ask, for the screen the panel opened on; an attached Item gets its own. */
/** The screen a path shows, for the "Looking at" line; Home and the rest add nothing a question needs. */
function lookingAt(path: string): { looking: Looking; label: string } | null {
  const campaign = path.match(/\/campaigns\/([0-9a-f-]{36})(?:\/|$)/)?.[1];
  if (campaign) return { looking: { screen: "campaigns", campaignId: campaign }, label: "this Campaign" };
  if (/\/campaigns\/?$/.test(path)) return { looking: { screen: "campaigns" }, label: "Campaigns" };
  if (path.includes("/calendar")) return { looking: { screen: "calendar" }, label: "Calendar" };
  if (path.includes("/review")) return { looking: { screen: "review" }, label: "Review" };
  return null;
}

function startersFor(path: string, about: boolean): string[] {
  if (about) return ["Make it shorter", "Move it to Friday at 9:00", "Why is this held?"];
  if (path.includes("/calendar")) return ["What goes out this week?", "What's held this week, and why?", "Move Tuesday's post to Thursday"];
  if (path.includes("/review")) return ["Which of these goes out first?", "Why is the oldest one held?", "What needs me before Friday?"];
  if (path.includes("/campaigns")) return ["Which Campaign needs me?", "Start the next step on a Campaign", "What's planned for my Campaigns this week?"];
  return ["What needs me this week?", "What goes out this week?", "Why is something held?"];
}
const and = new Intl.ListFormat("en-GB", { type: "conjunction" });
const when = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

function Conversation(p: { workspaceId: string; role: Role; about: About | undefined; onDropAbout: () => void; send: Send; error: string | null; onClose: () => void }) {
  const data = useQuery(askQuery(p.workspaceId)).data;
  const messages = data?.messages ?? [];
  // Said before anyone types, not after: a message sent while Ask is off only comes back with "off".
  const off = data?.on === false;
  const path = useRouterState({ select: (s) => s.location.pathname });
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  // The screen goes with each message until the person removes it; a new screen brings it back.
  const [droppedOn, setDroppedOn] = useState<string>();
  const screen = !p.about && droppedOn !== path ? lookingAt(path) : null;
  const [agent, setAgent] = useState<Area>();
  // The words on their way, shown at once so Send never looks like it did nothing.
  const [sending, setSending] = useState<string | null>(null);
  // Typing @ at the start offers the Agents by work area; picking one names it for the next message.
  const typed = text.match(/^@(\w*)$/)?.[1];
  const offered = typed === undefined ? [] : AREAS.filter((a) => a.startsWith(typed.toLowerCase()));
  // The newest message and its reply are what the person is waiting on, so keep them in view.
  const list = useRef<HTMLOListElement>(null);
  const last = messages.at(-1);
  const tail = `${messages.length}:${last?.status}:${last?.steps.length}:${sending !== null}`;
  // Pinned to the bottom unless the person scrolled up to read; a card that loads after its reply
  // grows the list, so growth keeps the bottom in view too.
  const pinned = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTop = el.scrollHeight;
  }, [tail]);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const watch = new MutationObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    watch.observe(el, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, []);
  const onScroll = () => {
    const el = list.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const t = text.trim();
    if (!t || sending !== null) return;
    setSending(t);
    setText("");
    try {
      // A message that didn't go gets its words back in the box.
      if (await p.send(t, { itemId: p.about?.itemId, agent, looking: screen?.looking })) setText(t);
    } finally {
      setSending(null);
    }
  }
  const pick = (a: Area) => {
    setAgent(a);
    setText("");
  };
  // Enter sends; Shift Enter starts a new line. While Agents are offered, Enter or Tab picks the first.
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const first = offered[0];
    if (first && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
      e.preventDefault();
      pick(first);
      return;
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    void submit();
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2>Ask Direx</h2>
        <Button variant="outline" size="sm" onClick={p.onClose}>
          Close
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">Nothing goes out until you approve it.</p>
      <ol ref={list} onScroll={onScroll} aria-label="Conversation" aria-live="polite" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {messages.length === 0 && sending === null && !off && (
          <li className="flex flex-col gap-3">
            {/* A starter fills the box rather than sending, so the person can change it first. */}
            <div role="group" aria-label="Things to ask" className="flex flex-col gap-2">
              {startersFor(path, !!p.about).map((s) => (
                <Button
                  key={s}
                  type="button"
                  variant="outline"
                  className="justify-start"
                  onClick={() => {
                    setText(s);
                    box.current?.focus();
                  }}
                >
                  {s}
                </Button>
              ))}
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm text-muted-foreground">Or hand it to an Agent</span>
              <div role="group" aria-label="Agents" className="flex flex-wrap gap-2">
                {AREAS.map((a) => (
                  <Button key={a} type="button" variant="outline" size="sm" aria-pressed={agent === a} onClick={() => pick(a)}>
                    {agentName(a)}
                  </Button>
                ))}
              </div>
            </div>
          </li>
        )}
        {messages.map((m) => (
          <Message key={m.id} m={m} workspaceId={p.workspaceId} role={p.role} />
        ))}
        {sending !== null && (
          <li className="flex flex-col gap-1">
            <p className="self-end rounded-card bg-muted px-3 py-2 whitespace-pre-line">{sending}</p>
            <p className="text-sm text-muted-foreground">Sending…</p>
          </li>
        )}
      </ol>
      <form onSubmit={submit} className="flex flex-col gap-2">
        {p.about && (
          <p className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">About: {p.about.title}</span>
            <Button type="button" variant="ghost" size="sm" aria-label={`Remove About: ${p.about.title}`} onClick={p.onDropAbout}>
              Remove
            </Button>
          </p>
        )}
        {screen && (
          <p className="flex items-center gap-2 text-sm">
            <span className="flex-1">Looking at: {screen.label}</span>
            <Button type="button" variant="ghost" size="sm" aria-label={`Remove Looking at: ${screen.label}`} onClick={() => setDroppedOn(path)}>
              Remove
            </Button>
          </p>
        )}
        {agent && (
          <p className="flex items-center gap-2 text-sm">
            <span className="flex-1">To: @{agentName(agent)}</span>
            <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${agentName(agent)} Agent`} onClick={() => setAgent(undefined)}>
              Remove
            </Button>
          </p>
        )}
        {off && <p className="rounded-card bg-warning-tint px-3 py-2 text-sm">Ask is off until Direx finishes checking it. The rest of Direx works as usual.</p>}
        <label htmlFor="ask-text" className="sr-only">
          Your message
        </label>
        <Textarea ref={box} id="ask-text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} maxLength={MAX_CHARS} placeholder="Ask, or type @ to name an Agent" disabled={off} autoFocus />
        {offered.length > 0 && (
          <div role="group" aria-label="Name an Agent" className="flex flex-wrap gap-2">
            {offered.map((a) => (
              <Button key={a} type="button" variant="outline" size="sm" onClick={() => pick(a)}>
                @{agentName(a)}
              </Button>
            ))}
          </div>
        )}
        {p.error && (
          <p role="alert" className="text-sm text-destructive">
            {p.error}
          </p>
        )}
        <Button type="submit" disabled={off || sending !== null || !text.trim() || text.trim().length > MAX_CHARS} className="self-end">
          Send
        </Button>
      </form>
    </>
  );
}

function Message({ m, workspaceId, role }: { m: AskMessage; workspaceId: string; role: Role }) {
  const r = m.reply;
  const ids = r ? [...(r.itemId ? [r.itemId] : []), ...(r.cites ?? [])] : [];
  return (
    <li className="flex flex-col gap-1">
      <p className="self-end rounded-card bg-muted px-3 py-2 whitespace-pre-line">
        {m.agent && <span className="font-medium">{`@${agentName(m.agent)} `}</span>}
        {m.text}
      </p>
      {m.itemId && <AboutLine workspaceId={workspaceId} id={m.itemId} />}
      {m.status === "working" ? (
        // Every step so far, so a run of several seconds reads as moving, not stalled.
        <ul aria-label="What Ask is doing" className="flex flex-col gap-1 text-sm text-muted-foreground">
          {m.steps.slice(0, -1).map((s, i) => (
            <li key={i}>{`✓ ${s}`}</li>
          ))}
          <li className="flex items-center gap-2 text-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-foreground motion-safe:animate-pulse" />
            {`${m.steps.at(-1) ?? "Working"}…`}
          </li>
        </ul>
      ) : (
        r && (
          <div className="flex flex-col gap-2">
            {r.kind === "cannot" ? <p className="self-start rounded-card bg-warning-tint px-3 py-2 text-sm whitespace-pre-line">{r.text}</p> : <p className="whitespace-pre-line">{r.text}</p>}
            {r.looked?.length ? <p className="text-xs text-muted-foreground">{`Looked at ${and.format(r.looked)}`}</p> : null}
            {ids.map((id) => (
              <ItemCard key={id} workspaceId={workspaceId} id={id} role={role} {...(r.kind === "rewrite" && id === r.itemId && r.before && { before: r.before, since: m.createdAt })} />
            ))}
            {/* Where accepted work stands, in Direx's own words from its records, never the model's. */}
            {m.done && (
              <div aria-label="Where the work stands" className="flex flex-col gap-2">
                <p className={m.done.state === "refused" || m.done.state === "failed" ? "self-start rounded-card bg-warning-tint px-3 py-2 text-sm" : "text-sm text-muted-foreground"}>{m.done.text}</p>
                {m.done.itemIds.map((id) => (
                  <ItemCard key={id} workspaceId={workspaceId} id={id} role={role} />
                ))}
              </div>
            )}
          </div>
        )
      )}
    </li>
  );
}

const sameWords = (a: Words, b: Words | null) => !b || (a.subject === b.subject && a.text === b.text);

/** What a rewrite changed, word by word, with the length before and after; nothing until it has landed. */
function RewriteDiff(p: { before: Words; now: Words | null }) {
  if (sameWords(p.before, p.now)) return <p className="text-sm text-muted-foreground">The new version shows here once it's written.</p>;
  const now = p.now!;
  const flat = (w: Words) => [...(w.subject ? ["Subject:", ...wordsOf(w.subject), "·"] : []), ...wordsOf(w.text)].join("\n");
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="text-xs text-muted-foreground">{`${wordsOf(p.before.text).length} → ${wordsOf(now.text).length} words`}</p>
      <p aria-label="What the rewrite changed">
        {lineDiff(flat(p.before), flat(now)).map((d, i) =>
          d.kind === "removed" ? (
            <del key={i} className="text-muted-foreground">{`${d.line} `}</del>
          ) : d.kind === "added" ? (
            <ins key={i} className="bg-success-tint no-underline">{`${d.line} `}</ins>
          ) : (
            <span key={i}>{`${d.line} `}</span>
          ),
        )}
      </p>
    </div>
  );
}

/** Which Item a sent message was about, by its title; one no longer in the queue says so. */
function AboutLine(p: { workspaceId: string; id: string }) {
  const q = useQuery(itemQuery(p.workspaceId, p.id));
  const title = q.data?.item.title;
  if (q.isPending) return null;
  return <p className="self-end text-sm text-muted-foreground">{title ? `About: ${title}` : "About something no longer in your queue"}</p>;
}

/** An Item a reply made or named, as it stands now. */
function ItemCard(p: { workspaceId: string; id: string; role: Role; before?: Words; since?: string }) {
  const client = useQueryClient();
  // A rewrite lands after Ask replies, so its card asks again until the new words are there, for a while.
  const waiting = (d: unknown) => !!p.before && !!p.since && Date.now() - Date.parse(p.since) < REWRITE_WAIT_MS && sameWords(p.before, wordsIn(d));
  const detail = useQuery({ ...itemQuery(p.workspaceId, p.id), refetchInterval: (q) => (waiting(q.state.data?.content) ? 3000 : false) }).data;
  const item = detail?.item;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const targetId = item?.kind === "reschedule" ? (detail?.content as { targetId?: string } | null)?.targetId : undefined;
  // What a move does to the Item it moves: an approved send goes back to Needs approval.
  const target = useQuery({ ...itemQuery(p.workspaceId, targetId ?? ""), enabled: !!targetId }).data?.item;
  if (!item) return null;
  // Starting work needs what its button needs, which is editing for every start Ask offers.
  const onCard = APPROVE_ON_CARD.has(item.kind) && item.state === "needs_approval" && (item.kind === "ask_start" ? mayEdit(p.role) : mayApprove(p.role));
  // The change itself, so a yes on the card is never a yes to something unseen.
  const move = item.kind === "reschedule" ? (detail.content as { from?: string | null; at?: string } | null) : null;
  const fact = item.kind === "fact_proposal" ? (detail.content as { value?: string } | null) : null;
  const reapprove = target?.state === "scheduled" ? " It will need approval again." : "";
  const undone = detail.timeline.at(-1)?.reason === "Undone";
  const mayUndo = detail.undo?.ok === true && (item.kind === "reschedule" ? mayEdit(p.role) : mayApprove(p.role));
  async function decide(f: () => Promise<string | null>, words: Record<string, string> = {}) {
    setPending(true);
    try {
      const refused = await f();
      setError(refused && (words[refused] ?? message(refused)));
      setConfirming(false);
      await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
    } finally {
      setPending(false);
    }
  }
  const yes = () => decide(() => approve(p.workspaceId, item));
  return (
    <div className="flex flex-col gap-2 rounded-card border border-border p-3">
      {/* A move's title ends in the time in the Workspace's zone; the line below gives it in the person's own. */}
      <p className="font-medium">{move?.at && item.title.includes('" to ') ? item.title.slice(0, item.title.lastIndexOf('" to ') + 1) : item.title}</p>
      {move?.at && (
        <p className="text-sm">
          <span className="text-muted-foreground line-through">{move.from ? when.format(new Date(move.from)) : "Not planned"}</span>
          {" → "}
          <span className="font-medium">{when.format(new Date(move.at))}</span>
        </p>
      )}
      {p.before && <RewriteDiff before={p.before} now={wordsIn(detail.content)} />}
      {fact?.value && <blockquote className="border-l-2 border-border pl-3 text-sm whitespace-pre-line">{fact.value}</blockquote>}
      {onCard && reapprove && <p className="text-sm text-muted-foreground">{`It's approved to go at its current time.${reapprove}`}</p>}
      {undone && <p className="text-sm text-muted-foreground">{item.kind === "reschedule" ? "Moved back" : "Removed from Brand"}</p>}
      {confirming ? (
        <div className="flex flex-col gap-2 rounded-card bg-muted p-2 text-sm">
          <p>{move?.from ? `Move it back to ${when.format(new Date(move.from))}?${reapprove}` : "Remove this from Brand? Emails written from it will ask to be read again before they go."}</p>
          <div className="flex gap-2">
            <Button size="sm" pending={pending} onClick={() => void decide(() => undo(p.workspaceId, item.id), NO_UNDO)}>
              {item.kind === "reschedule" ? "Move it back" : "Remove"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <StateChip state={item.state} reason={item.reason} />
        {mayUndo && !confirming && (
          <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
            Undo
          </Button>
        )}
        {onCard && (
          <Button size="sm" pending={pending} onClick={() => void yes()}>
            {item.kind === "reschedule" ? "Approve move" : item.kind === "ask_start" ? "Start" : "Add Fact"}
          </Button>
        )}
        <Link to="/w/$workspaceId/review/$itemId" params={{ workspaceId: p.workspaceId, itemId: item.id }} className={buttonVariants({ variant: "outline", size: "sm" })}>
          Open
        </Link>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** On an Item: opens the panel with that Item attached. */
export function AskAbout(p: { id: string; title: string }) {
  const a = useAsk();
  if (!a) return null;
  return (
    <Button variant="outline" size="sm" onClick={() => a.open({ itemId: p.id, title: p.title })}>
      Ask about this
    </Button>
  );
}

/** The sidebar's way in, beside search. */
export function AskButton(p: { compact?: boolean } = {}) {
  const a = useAsk();
  if (!a) return null;
  if (p.compact)
    return (
      <RailTip label="Ask Direx · Ctrl J">
        <button type="button" data-slot="rail" className={railButton} aria-label="Ask Direx" aria-keyshortcuts="Control+J Meta+J" aria-haspopup="dialog" onClick={() => a.open()}>
          <MessageSquareIcon className="size-5" aria-hidden />
        </button>
      </RailTip>
    );
  return (
    <Button variant="outline" size="sm" className="justify-between" aria-keyshortcuts="Control+J Meta+J" aria-haspopup="dialog" onClick={() => a.open()}>
      Ask Direx <kbd aria-hidden className={kbd}>Ctrl J</kbd>
    </Button>
  );
}

/** The prompt box on Home: opens the panel at once and sends the message, so the reply shows there.
 *  A refusal shows in the panel, and the words come back to this box. */
export function AskBox() {
  const a = useAsk();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  if (!a) return null;
  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const t = text.trim();
    if (!t || !a || pending) return;
    setPending(true);
    setText("");
    a.open();
    try {
      if (await a.send(t)) setText(t);
    } finally {
      setPending(false);
    }
  }
  // Enter asks, as in the panel; Shift Enter starts a new line.
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    void submit();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row" aria-label="Ask Direx">
      <label htmlFor="ask-home" className="sr-only">
        Ask Direx
      </label>
      <Textarea id="ask-home" rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} maxLength={MAX_CHARS} placeholder="Ask Direx what needs you, or to move or rewrite something" className="min-h-9 flex-1" />
      <Button type="submit" pending={pending} disabled={!text.trim() || text.trim().length > MAX_CHARS}>
        Ask
      </Button>
    </form>
  );
}
