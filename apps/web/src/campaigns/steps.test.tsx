// SPDX-License-Identifier: AGPL-3.0-only
// The DM, email template and social post steps in a DOM: each button is busy while its call runs,
// what worked says so in a toast, and a refusal stays on the step as an error.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import type { Post } from "../social/actions";
import type { Dm, Step } from "./actions";
import { ClipsStep } from "./ClipsStep";
import { DmStep } from "./DmStep";
import { PostStep } from "./PostStep";
import { StepRow } from "./Setup";
import { TemplateStep } from "./Step";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
/** A reply the test sends when it chooses, so it can see the button while the call runs. */
function held() {
  let send!: (status: number, body: unknown) => void;
  const promise = new Promise((resolve) => {
    send = (status, body) => resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
  });
  return { promise, send };
}
const busy = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-busy");
const base: Step = { key: "first", on: "2026-11-03", title: "First", inPlan: true, type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dmChannel: null, dependsOnStepKey: null, outputConnection: null, outputNetworkId: null, utm: false, draftingMode: null, cancelled: false, waived: false, waitingOn: null, output: null, planChange: null, templateRevision: 1, template: null, writerNotes: null, writerNotesRevision: 0 };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Handler = (path: string) => Promise<unknown> | undefined;
/** Each method answers from its handler, and anything else answers not found. */
function serve(o: { get?: Handler; post?: Handler; put?: Handler }) {
  const fallback = (h?: Handler) => ((path: string) => h?.(path) ?? reply(404, { error: "not_found" })) as never;
  return { get: vi.spyOn(api, "GET").mockImplementation(fallback(o.get)), post: vi.spyOn(api, "POST").mockImplementation(fallback(o.post)), put: vi.spyOn(api, "PUT").mockImplementation(fallback(o.put)) };
}

// DM step

const dm: Dm = { id: "d1", personId: "p1", channel: "linkedin", profileUrl: "https://linkedin.test/in/kim", text: "Hi Kim", copiedAt: null, sentAt: null };
const dmStep: Step = { ...base, type: "dm", dmChannel: "linkedin", template: { subject: "", text: "Hi {{firstName}}", warnings: [], needsDecision: [] } };
const showDm = () => render(withQueries(<DmStep workspaceId={W} id={ID} step={dmStep} edit initial={[dm]} />));
const dmList = (path: string) => (path.endsWith("/dms") ? reply(200, { dms: [dm] }) : undefined);

test("saving the DM message is busy while it saves, then says what to check", async () => {
  const save = held();
  const { put } = serve({ get: dmList, put: () => save.promise });
  showDm();
  await userEvent.click(screen.getByRole("button", { name: "Save message" }));
  expect(busy("Save message")).toBe("true");
  expect(put.mock.calls[0]![1]).toMatchObject({ body: { revision: 1, text: "Hi {{firstName}}" } });
  save.send(200, { revision: 2, warnings: ["It is long."] });
  expect(await screen.findByText("Saved. To check: It is long.")).toBeTruthy();
  expect(busy("Save message")).toBeNull();
});

test("a refused DM save stays on the step and shows no toast", async () => {
  serve({ get: dmList, put: () => reply(409, { error: "step_cancelled" }) });
  showDm();
  await userEvent.click(screen.getByRole("button", { name: "Save message" }));
  expect((await screen.findByRole("alert")).textContent).toBe("This step was cancelled.");
  expect(screen.queryByText("Saved.")).toBeNull();
});

test("Make DMs is busy while it runs, then lists who was left out and why", async () => {
  const make = held();
  serve({ get: dmList, post: () => make.promise });
  showDm();
  await userEvent.click(screen.getByRole("button", { name: "Make DMs" }));
  expect(busy("Make DMs")).toBe("true");
  make.send(200, { results: [{ personId: "p1", email: "kim@acme.test", ok: true }, { personId: "p2", email: "lee@acme.test", ok: false, reason: "no_profile" }, { personId: "p3", email: null, ok: false, leftOut: { reason: "replied" } }] });
  expect(await screen.findByText("lee@acme.test: no profile saved for this network")).toBeTruthy();
  expect(screen.getByText("p3: replied")).toBeTruthy();
  expect(screen.queryByText(/kim@acme.test/)).toBeNull();
});

test("a refused Make DMs says why", async () => {
  serve({ get: dmList, post: () => reply(409, { error: "step_cancelled" }) });
  showDm();
  await userEvent.click(screen.getByRole("button", { name: "Make DMs" }));
  expect((await screen.findByRole("alert")).textContent).toBe("This step was cancelled.");
});

test("Copy and open profile copies the edited text, opens the profile, and says to send it", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const copied = held();
  const { post } = serve({ get: dmList, post: () => copied.promise });
  showDm();
  await user.type(screen.getByRole("textbox", { name: "DM text" }), "!");
  await user.click(screen.getByRole("button", { name: "Copy and open profile" }));
  expect(write).toHaveBeenCalledWith("Hi Kim!");
  expect(open).toHaveBeenCalledWith(dm.profileUrl, "_blank", "noopener");
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/dms/{dmId}/copied", { params: { path: { workspaceId: W, dmId: "d1" } } }));
  expect(busy("Copy and open profile")).toBe("true");
  copied.send(200, { direxTouchNear: false });
  expect(await screen.findByText("Copied. Send it, then mark it sent.")).toBeTruthy();
});

test("copying a DM to someone Direx emails soon warns it may land close to that email", async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  vi.spyOn(window, "open").mockReturnValue(null);
  serve({ get: dmList, post: () => reply(200, { direxTouchNear: true }) });
  showDm();
  await user.click(screen.getByRole("button", { name: "Copy and open profile" }));
  expect(await screen.findByText("Copied. Direx emailed them, or will, within 3 days, so this may land close to it.")).toBeTruthy();
});

test("Mark sent is busy while it saves, then says the next cold email waits", async () => {
  const mark = held();
  serve({ get: dmList, post: () => mark.promise });
  showDm();
  await userEvent.click(screen.getByRole("button", { name: "Mark sent" }));
  expect(busy("Mark sent")).toBe("true");
  mark.send(200, {});
  expect(await screen.findByText("Marked sent. Direx's next cold email to them waits 3 days.")).toBeTruthy();
});

test("a refused Mark sent says why", async () => {
  serve({ get: dmList, post: () => reply(409, { error: "step_cancelled" }) });
  showDm();
  await userEvent.click(screen.getByRole("button", { name: "Mark sent" }));
  expect((await screen.findByRole("alert")).textContent).toBe("This step was cancelled.");
});

// Email template step

const emailStep: Step = { ...base, template: { subject: "Hello", text: "Hi {{firstName}}", warnings: [], needsDecision: [] } };
const preview = (path: string) => (path.endsWith("/drafts-preview") ? reply(200, { willMake: 2, already: 0, leftOut: [], sample: null }) : undefined);
const showTemplate = (onChange = () => {}) => render(withQueries(<TemplateStep workspaceId={W} id={ID} step={emailStep} edit onChange={onChange} />));

test("saving the email is busy while it saves, then says which unsent drafts need approving again", async () => {
  const save = held();
  const onChange = vi.fn();
  const { put } = serve({ get: preview, put: () => save.promise });
  showTemplate(onChange);
  await userEvent.click(screen.getByRole("button", { name: "Edit email" }));
  await userEvent.click(screen.getByRole("button", { name: "Save email" }));
  expect(busy("Save email")).toBe("true");
  expect(put.mock.calls[0]![1]).toMatchObject({ body: { revision: 1, subject: "Hello", text: "Hi {{firstName}}" } });
  save.send(200, { revision: 2, revised: 1, failed: [{ itemId: "i1", reason: "sent" }] });
  expect(await screen.findByText("Saved. 1 draft not yet sent now say this and need approving again. 1 didn't change, because they were already sent or are missing a field.")).toBeTruthy();
  expect(onChange).toHaveBeenCalled();
});

test("saving an email no draft uses yet just says Saved", async () => {
  serve({ get: preview, put: () => reply(200, { revision: 2, revised: 0, failed: [] }) });
  showTemplate();
  await userEvent.click(screen.getByRole("button", { name: "Edit email" }));
  await userEvent.click(screen.getByRole("button", { name: "Save email" }));
  expect(await screen.findByText("Saved.")).toBeTruthy();
});

test("a refused email save stays on the step and nothing changes", async () => {
  const onChange = vi.fn();
  serve({ get: preview, put: () => reply(409, { error: "step_cancelled" }) });
  showTemplate(onChange);
  await userEvent.click(screen.getByRole("button", { name: "Edit email" }));
  await userEvent.click(screen.getByRole("button", { name: "Save email" }));
  expect(await screen.findByText("This step was cancelled.")).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
});

test("making drafts is busy while it runs, then says how many wait for approval", async () => {
  const make = held();
  serve({ get: preview, post: (path) => (path.endsWith("/make-drafts") ? make.promise : undefined) });
  showTemplate();
  await userEvent.click(await screen.findByRole("button", { name: "Make 2 drafts" }));
  expect(busy("Make 2 drafts")).toBe("true");
  make.send(200, { results: [{ personId: "p1", ok: true, already: false }, { personId: "p2", ok: true, already: true }] });
  expect(await screen.findByText("1 draft waiting for approval. Nothing is sent until each is approved.")).toBeTruthy();
});

test("refused drafts and a refused rewrite each say why", async () => {
  serve({ get: preview, post: () => reply(409, { error: "step_cancelled" }) });
  showTemplate();
  await userEvent.click(await screen.findByRole("button", { name: "Make 2 drafts" }));
  expect(await screen.findByText("This step was cancelled.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Write First again" }));
  expect(await screen.findByText("This step was cancelled.")).toBeTruthy();
  expect(busy("Write First again")).toBeNull();
});

test("the email shows as it will appear, with fields as chips and where it goes above it; Edit opens the form", async () => {
  serve({ get: (path) => (path.endsWith("/drafts-preview") ? reply(200, { willMake: 2, already: 1, leftOut: [], sample: { email: "kim@acme.test", subject: "Hello", text: "Hi Kim" } }) : undefined) });
  showTemplate();
  const frame = screen.getByRole("article", { name: "Email as it will appear" });
  expect(frame.textContent).toContain("Hi first name");
  expect(frame.querySelector("mark")?.textContent).toBe("first name");
  expect(frame.textContent).not.toContain("{{");
  const strip = screen.getByLabelText("Where it goes");
  expect(await screen.findByText("3 people")).toBeTruthy();
  expect(strip.textContent).toContain("No Mailbox yet");
  expect(strip.textContent).toContain("Tue 3 Nov");
  expect(screen.getByText("Filled in for kim@acme.test")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save email" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Edit email" }));
  expect(screen.queryByRole("article", { name: "Email as it will appear" })).toBeNull();
  // While the form is open, Save is the one primary button: Make drafts waits.
  expect(screen.queryByRole("button", { name: "Make 2 drafts" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("article", { name: "Email as it will appear" })).toBeTruthy();
});

test("the email names its Mailbox once the list loads", async () => {
  serve({
    get: (path) => {
      if (path.endsWith("/credentials")) return reply(200, { credentials: [{ id: "m1", name: "Sam at Northbeam", connection: "smtp" }] });
      if (path.endsWith("/mailbox-providers")) return reply(200, { providers: [{ connection: "smtp" }] });
      return preview(path);
    },
  });
  render(withQueries(<TemplateStep workspaceId={W} id={ID} step={{ ...emailStep, mailboxCredentialId: "m1" }} edit onChange={() => {}} />));
  expect((await screen.findAllByText(/Sam at Northbeam/)).length).toBe(2);
});

// Social post step

const postStep: Step = { ...base, type: "post" };
const network = { connection: "instagram", label: "Instagram", accountTypes: [], connect: "form", availability: "available", canConnect: true, publishes: false, app: null };
const post = (o: Partial<Post> = {}): Post => ({ id: "s1", itemId: "i1", clipId: null, connection: "instagram", network: "Instagram", accountName: null, mode: "manual", text: "Launch day", video: null, images: [], url: null, followUps: [], state: "needs_approval", reason: null, revision: 1, clean: true, warnings: [], at: null, ...o });
const social = (posts: Post[], networks: unknown[] = [network]) => (path: string) => {
  if (path.endsWith("/social/networks")) return reply(200, { networks });
  if (path.endsWith("/social/accounts")) return reply(200, { accounts: [] });
  if (path.endsWith("/social/posts")) return reply(200, { posts });
  return undefined;
};
const showPost = (approve = false) => render(withQueries(<PostStep workspaceId={W} id={ID} step={postStep} edit approve={approve} />));

test("with no networks, the post step offers to connect an account", async () => {
  serve({ get: social([], []) });
  showPost();
  expect(await screen.findByText("No networks yet")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Connect an account" }).getAttribute("href")).toBe(`/w/${W}/settings/social`);
});

test("Check against each network is busy while it checks, then says each one is ready", async () => {
  const check = held();
  serve({ get: social([]), post: (path) => (path.endsWith("/preview") ? check.promise : undefined) });
  showPost();
  await userEvent.click(await screen.findByRole("checkbox", { name: /Instagram/ }));
  await userEvent.click(screen.getByRole("button", { name: "Check against each network" }));
  expect(busy("Check against each network")).toBe("true");
  check.send(200, { ok: true, mode: "manual", text: "" });
  expect(await screen.findByText(/^Instagram: ready/)).toBeTruthy();
});

test("Save as drafts is busy while it writes, then shows each network that refused", async () => {
  const write = held();
  const { put } = serve({ get: social([]), put: () => write.promise });
  showPost();
  await userEvent.click(await screen.findByRole("checkbox", { name: /Instagram/ }));
  await userEvent.type(screen.getByRole("textbox", { name: "Text" }), "Launch day");
  await userEvent.click(screen.getByRole("button", { name: "Save as drafts" }));
  expect(busy("Save as drafts")).toBe("true");
  expect(put.mock.calls[0]![1]).toMatchObject({ body: { targets: [{ connection: "instagram", text: "Launch day" }] } });
  write.send(200, { results: [{ connection: "instagram", ok: false, detail: "Too long for Instagram." }] });
  expect((await screen.findByRole("alert")).textContent).toBe("instagram: Too long for Instagram.");
});

test("when writing drafts fails outright, the post step says to try again", async () => {
  serve({ get: social([]), put: () => reply(500, { error: "failed" }) });
  showPost();
  await userEvent.click(await screen.findByRole("checkbox", { name: /Instagram/ }));
  await userEvent.type(screen.getByRole("textbox", { name: "Text" }), "Launch day");
  await userEvent.click(screen.getByRole("button", { name: "Save as drafts" }));
  expect((await screen.findByRole("alert")).textContent).toBe("That didn't go through. Try again.");
});

test("Save as drafts with no text says to write it, and sends nothing", async () => {
  const { put } = serve({ get: social([]) });
  showPost();
  await userEvent.click(await screen.findByRole("checkbox", { name: /Instagram/ }));
  await userEvent.click(screen.getByRole("button", { name: "Save as drafts" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Write the post's text first.");
  await userEvent.click(screen.getByLabelText("Write a version for each account"));
  await userEvent.click(screen.getByRole("button", { name: "Save as drafts" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Write the text for Instagram first.");
  expect(put).not.toHaveBeenCalled();
});

test("a refused Write it for me says why", async () => {
  serve({ get: social([]), post: () => reply(409, { error: "step_cancelled" }) });
  showPost();
  await userEvent.click(screen.getByRole("button", { name: "Write it for me" }));
  expect((await screen.findByRole("alert")).textContent).toBe("This step was cancelled.");
  expect(busy("Write it for me")).toBeNull();
});

test("Approve all is busy while it runs, then shows the first refusal", async () => {
  const all = held();
  serve({ get: social([post(), post({ id: "s2", itemId: "i2" })]), post: (path) => (path.endsWith("/approve-clean") ? all.promise : undefined) });
  showPost(true);
  await userEvent.click(await screen.findByRole("button", { name: "Approve all 2 without warnings" }));
  expect(busy("Approve all 2 without warnings")).toBe("true");
  all.send(200, { results: [{ id: "i1", ok: true }, { id: "i2", ok: false, reason: "stale" }] });
  expect((await screen.findByRole("alert")).textContent).toBe("Someone else changed this just now. Try again.");
});

test("approving one post is busy while it runs, and a refusal shows on that post", async () => {
  const one = held();
  serve({ get: social([post()]), post: (path) => (path.endsWith("/approve") ? one.promise : undefined) });
  showPost(true);
  await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(busy("Approve")).toBe("true");
  one.send(409, { error: "stale" });
  expect((await screen.findByRole("alert")).textContent).toBe("Someone else changed this just now. Try again.");
});

test("Request changes on a post waiting for approval starts its writer, says it's working, and shows the new version", async () => {
  let revision = 1;
  const posts = () => [post({ revision, text: revision > 1 ? "Launch, shorter" : "Launch day" })];
  const { post: calls } = serve({
    get: (path) => (path.endsWith("/items/{id}") ? reply(200, { item: { revision } }) : path.endsWith("/agents/runs/{id}") ? reply(200, { status: "running" }) : social(posts())(path)),
    post: (path) => (path.endsWith("/rewrite") ? reply(200, { runId: "r1" }) : undefined),
  });
  showPost(true);
  expect(screen.queryByRole("region", { name: "Rewrite" })).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: "Request changes" }));
  const tools = await screen.findByRole("region", { name: "Rewrite" });
  await userEvent.click(within(tools).getByRole("button", { name: "Shorter" }));
  expect(calls).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/rewrite", { params: { path: { workspaceId: W, id: "i1" } }, body: { preset: "shorter", timeZone: expect.any(String) } });
  expect(await screen.findByText("Rewriting. This usually takes about 15 seconds.")).toBeTruthy();
  revision = 2;
  // The new version reloads the step's posts, and the request closes.
  expect(await screen.findByText("Launch, shorter", undefined, { timeout: 5_000 })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Rewrite" })).toBeNull();
});

test("a post already approved offers no Request changes", async () => {
  serve({ get: social([post({ state: "scheduled" })]) });
  showPost(true);
  expect(await screen.findByRole("button", { name: "Edit text" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
});

test("marking a post as posted by you says when the link didn't save", async () => {
  const mark = held();
  const { post: calls } = serve({ get: social([post({ state: "scheduled" })]), post: (path) => (path.endsWith("/posted") ? mark.promise : undefined) });
  showPost(true);
  await userEvent.type(await screen.findByLabelText(/Link to your post/), "https://instagram.test/p/1");
  await userEvent.click(screen.getByRole("button", { name: "Mark as posted by you" }));
  expect(busy("Mark as posted by you")).toBe("true");
  expect(calls.mock.calls.at(-1)![1]).toMatchObject({ body: { url: "https://instagram.test/p/1" } });
  mark.send(400, { error: "bad_url" });
  expect((await screen.findByRole("alert")).textContent).toBe("That link didn't save. Check it and try again.");
});

test("drafted posts come before the composer, each a card on its network with its state as a chip", async () => {
  serve({ get: social([post({ mode: "publish", accountName: "Sam Reyes" })]) });
  showPost(true);
  const card = await screen.findByRole("region", { name: "Instagram post" });
  expect(card.textContent).toContain("Sam Reyes");
  expect(card.textContent).toContain("10 of 2200 characters");
  expect(screen.getByText("Needs approval")).toBeTruthy();
  expect(card.compareDocumentPosition(screen.getByRole("button", { name: "Save as drafts" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("Write more posts")).toBeTruthy();
});

test("a post with a link shows its link card from the Item", async () => {
  const appearance = { kind: "post", account: "Sam", network: "Instagram", link: { url: "https://acme.test/pricing", title: "Pricing", description: null, site: "acme.test", image: false } };
  serve({ get: (path) => (path.endsWith("/items/{id}") ? reply(200, { item: {}, appearance }) : social([post({ text: "See https://acme.test/pricing" })])(path)) });
  showPost();
  expect((await screen.findByRole("link", { name: /Pricing/ })).getAttribute("href")).toBe("https://acme.test/pricing");
});

test("Edit text saves the post, and Save and approve approves the saved version when it has no warnings", async () => {
  const { put, post: calls } = serve({
    get: (path) => (path.endsWith("/items/{id}") ? reply(200, { item: { id: "i1", revision: 2, state: "needs_approval", clean: true } }) : social([post()])(path)),
    put: () => reply(200, {}),
    post: () => reply(200, {}),
  });
  showPost(true);
  await userEvent.click(await screen.findByRole("button", { name: "Edit text" }));
  const box = screen.getByRole("textbox", { name: "Instagram post" });
  await userEvent.clear(box);
  await userEvent.type(box, "Launch week");
  await userEvent.click(screen.getByRole("button", { name: "Save and approve" }));
  const approved = () => (calls.mock.calls as unknown as [string, unknown][]).find(([path]) => path.endsWith("/approve"));
  await waitFor(() => expect(approved()).toBeTruthy());
  expect(put.mock.calls.at(-1)![1]).toMatchObject({ body: { text: "Launch week" } });
  expect(approved()![1]).toMatchObject({ body: { revision: 2 } });
});

test("a refused post edit stays open and says why", async () => {
  serve({ get: social([post()]), put: () => reply(409, { error: "stale" }) });
  showPost(true);
  await userEvent.click(await screen.findByRole("button", { name: "Edit text" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Instagram post" })).toBeTruthy();
});

// Clips step

const clip = { id: "c1", mediaId: "m1", startMs: 0, endMs: 30000, title: "The hook", caption: "Launch day", citations: [], measureKey: null, why: "Strong opener." };
const showClips = (posts: Post[]) => {
  const view = { recordings: [{ setup: { sourceMediaId: "src", accounts: [], firstAt: "2026-11-03T09:00:00Z" }, run: { id: "r1", state: "done", failure: null, dropped: [] }, clips: [clip], unposted: [], idle: [] }], lastAccounts: [] };
  serve({ get: (path) => (path.endsWith("/clips") ? reply(200, view) : social(posts)(path)) });
  render(withQueries(<ClipsStep workspaceId={W} id={ID} step={{ ...base, type: "clips" } as Step} edit={false} approve initial={{ accounts: [], networks: [], view: view as never, posts }} />));
};

test("a clip's post with a warning can be approved on its own row", async () => {
  showClips([post({ clipId: "c1", clean: false, warnings: [{ text: "Names a Fact not in the plan." }] as never })]);
  expect(screen.queryByRole("button", { name: "Approve this clip" })).toBeNull();
  expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
});

test("a clip posted by hand can be marked as posted", async () => {
  showClips([post({ clipId: "c1", state: "scheduled" })]);
  expect(await screen.findByRole("button", { name: "Mark as posted by you" })).toBeTruthy();
});

test("a step's setup sits folded under its one-line summary; a reader sees only the line", () => {
  const step = { key: "s1", on: "2026-11-04", title: "Intro email", inPlan: true, type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dmChannel: null, dependsOnStepKey: null, utm: null } as never;
  render(withQueries(<StepRow step={step} steps={[step]} boxes={[]} edit onSave={async () => {}} />));
  expect(screen.getByText("Wed 4 Nov Intro email")).toBeTruthy();
  const fold = screen.getByText("Change setup").closest("details")!;
  expect(fold.open).toBe(false);
  expect(fold.querySelector("form")).toBeTruthy();
  cleanup();
  render(withQueries(<StepRow step={step} steps={[step]} boxes={[]} edit={false} onSave={async () => {}} />));
  expect(screen.queryByText("Change setup")).toBeNull();
  expect(screen.getByRole("paragraph").textContent).toBe("Wed 4 Nov Intro email · email");
});

test("in the Step settings drawer the setup form shows at once, without the step's line", () => {
  const step = { key: "s1", on: "2026-11-04", title: "Intro email", inPlan: true, type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dmChannel: null, dependsOnStepKey: null, utm: null } as never;
  render(withQueries(<StepRow step={step} steps={[step]} boxes={[]} edit unfolded onSave={async () => {}} />));
  expect(screen.queryByText("Change setup")).toBeNull();
  expect(screen.queryByText("Wed 4 Nov Intro email")).toBeNull();
  expect(screen.getByRole("button", { name: "Save step" })).toBeTruthy();
});
