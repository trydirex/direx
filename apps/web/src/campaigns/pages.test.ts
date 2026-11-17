// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Smoke test for the campaign screens: each tab by role, what's on screen is escaped, and each action calls its endpoint.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { api } from "../client";
import { mailboxes } from "../outreach/actions";
import { copyDm, makeDms, markDmSent, recordOutput, saveDmText, addPeople, setCampaignPaused, settleConflict, editPersonDraft, personDrafts, personPreview, writePerPerson, type PersonDraft, type PersonPreview, draftsPreview, makeDrafts, removePerson, saveStep, saveTemplate, say, sayLeftOut, sayRow, talkingLine, setDraftingMode, progressLine, startStepDraft, type DraftsPreview, type Loaded, type Step } from "./actions";
import { PersonStep } from "./PersonStep";
import { choices, PostStep } from "./PostStep";
import { TemplateStep } from "./Step";
import { blindToDeals, Campaign } from "./Campaign";
import { DmStep } from "./DmStep";
import { LaunchLine, StepRow } from "./Setup";
import { buttons, withQueries, withoutButtons, selectOptions } from "../testing";
import { lineDiff, PlanImpact } from "./PlanChange";
import type { Impact } from "./actions";
import { loadLaterFields } from "@/testing";

// The date, time, number and file fields load on first use; a page rendered to a string shows them only once loaded.
beforeAll(loadLaterFields);

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const unlinked = { dependsOnStepKey: null, outputConnection: null, outputNetworkId: null, utm: false, waitingOn: null, output: null, draftingMode: null, cancelled: false, waived: false, planChange: null, writerNotes: null, writerNotesRevision: 0 };
const campaign: Loaded = {
  id: ID,
  planId: "00000000-0000-4000-8000-0000000000cc",
  title: "Q4",
  ownerUserId: "00000000-0000-4000-8000-0000000000dd",
  draftingMode: null,
  paused: false,
  status: "running",
  changesWaiting: false,
  createdBy: null,
  outsideContentAllowed: false,
  advance: "offer",
  advanceSetBy: null,
  advanceUpToCents: 100,
  notes: "",
  notesRevision: 0,
  notesUpdatedBy: null,
  notesUpdatedAt: null,
  goal: "4 meetings",
  startsOn: "2026-11-01",
  anchor: { on: "2026-11-01", stepKey: null },
  endsOn: "2026-11-30",
  planned: 2,
  done: 1,
  skipped: 0,
  sent: 3,
  replied: 1,
  steps: [
    { key: "first", on: "2026-11-03", title: "First email", inPlan: true, type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dmChannel: null, templateRevision: 0, template: null, ...unlinked },
    { key: "old", on: null, title: null, inPlan: false, type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dmChannel: null, templateRevision: 0, template: null, ...unlinked },
  ],
};
const people = [
  { personId: "00000000-0000-4000-8000-000000000001", status: "active", firstName: "Kim", company: "<b>Acme</b>", website: null, email: "kim@acme.test", blocked: "no basis recorded", country: null, warnings: [], lastEmailAt: null, conflict: { itemId: "c", revision: 1 } },
  { personId: "00000000-0000-4000-8000-000000000002", status: "active", firstName: "Lena", company: "GmbH", website: null, email: "lena@gmbh.test", blocked: null, country: "DE", warnings: ["consent_likely_needed" as const, "sender_country_missing" as const], lastEmailAt: "2026-11-03T10:00:00.000Z", conflict: null },
];
const pageEl = (role: "owner" | "viewer", tab: string) => withQueries(createElement(Campaign, { workspaceId: W, id: ID, role, tab, initial: { campaign, boxes: [{ id: "b", name: "Sam's mailbox" }], people } }));
const page = (role: "owner" | "viewer", tab: string) => renderToString(pageEl(role, tab));

test("an editor sets a step up, and a step the plan dropped says so", () => {
  const html = page("owner", "drafts");
  expect(html).toContain("Save step");
  // The setup form sits in the Step settings drawer, closed at first, so its choices are read from the form itself.
  expect(selectOptions(withQueries(createElement(StepRow, { step: campaign.steps[0]!, steps: campaign.steps, boxes: [{ id: "b", name: "Sam's mailbox" }], edit: true, unfolded: true, onSave: async () => {} })))["Email account"]?.options).toContain("Sam's mailbox");
  expect(html).toMatch(/no longer in the plan/i);
});

const page0 = { key: "page", on: "2026-11-02", title: "Launch page", inPlan: true, type: "manual", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dmChannel: null, templateRevision: 0, template: null };
const email0 = { key: "first", on: "2026-11-03", title: "First email", inPlan: true, type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dmChannel: null, templateRevision: 0, template: null };
/** The Content tab shows one step at a time, the first unless one needs approval; `emailFirst` puts the waiting email step first. */
const linkedPage = (role: "owner" | "viewer", output: Step["output"], emailFirst = false) =>
  renderToString(
    withQueries(createElement(Campaign, {
      workspaceId: W,
      id: ID,
      role,
      tab: "drafts",
      initial: {
        campaign: { ...campaign, steps: ((s: Step[]) => (emailFirst ? s.reverse() : s))([{ ...page0, ...unlinked, output }, { ...email0, ...unlinked, dependsOnStepKey: "page", waitingOn: output ? null : "page" }]) },
        boxes: [],
        people,
      },
    })),
  );

test("a step waits for a manual step's link, says so until it's added, and an editor adds it", () => {
  const waiting = linkedPage("owner", null, true);
  expect(waiting).toContain("Goes out after");
  expect(waiting).toContain("goes out after Launch page goes live");
  expect(waiting).toContain("Add tracking tags (UTM) to the link");
  expect(linkedPage("owner", null)).toContain("No link yet.");
  expect(linkedPage("owner", null)).toContain("Save link");
  expect(waiting).toContain("Waiting for the link from Launch page.");

  const ready = linkedPage("owner", { url: "https://acme.test/launch", version: 2, source: "person", at: "2026-11-02T09:00:00.000Z" });
  expect(ready).toContain("https://acme.test/launch");
  expect(ready).toContain("(version 2)");
  expect(linkedPage("owner", { url: "https://acme.test/launch", version: 2, source: "person", at: "2026-11-02T09:00:00.000Z" }, true)).not.toContain("Waiting for the link");
});

test("a viewer sees what a step waits for and its link, and can't change either", () => {
  const html = linkedPage("viewer", { url: "https://acme.test/launch", version: 1, source: "person", at: "2026-11-02T09:00:00.000Z" });
  expect(linkedPage("viewer", null, true)).toContain("goes out after Launch page goes live");
  expect(html).toContain("https://acme.test/launch");
  expect(html).not.toContain("Save link");
  expect(html).not.toContain("Goes out after");
});

test("saving a manual step's link calls its endpoint and returns the API's refusal", async () => {
  const post = vi.spyOn(api, "POST").mockResolvedValueOnce({ data: { stepKey: "page" } } as never).mockResolvedValueOnce({ error: { error: "bad_url" } } as never);
  expect(await recordOutput(W, ID, "page", "https://acme.test/launch")).toBeNull();
  expect(post.mock.calls[0]).toEqual(["/api/w/{workspaceId}/campaigns/{id}/steps/{key}/output", { params: { path: { workspaceId: W, id: ID, key: "page" } }, body: { url: "https://acme.test/launch" } }]);
  expect(await recordOutput(W, ID, "page", "http://acme.test")).toBe("bad_url");
  post.mockRestore();
});

test("a viewer reads the steps and can't change them", () => {
  const html = page("viewer", "drafts");
  expect(html).toContain("First email");
  expect(html).not.toContain("Save step");
});

test("a Person whose record has a suggestion shows it, and it doesn't stop their draft", () => {
  const html = page("viewer", "people");
  expect(html).toContain("To check: cold email to DE usually needs consent.");
  expect(html.split("add your own country under Who is sending")).toHaveLength(2);
  expect(html).not.toContain("lena@gmbh.test Lena GmbH : active (gets no draft");
});

test("an editor can add and remove people, and a viewer can't", () => {
  const owner = page("owner", "people");
  expect(owner).toContain("Add people");
  expect(owner).toContain("Actions for kim@acme.test");
  const viewer = page("viewer", "people");
  expect(viewer).toContain("kim@acme.test");
  expect(viewer).toContain("no basis recorded");
  expect(viewer).not.toContain("Add people");
  expect(viewer).not.toContain("Actions for");
  expect(viewer).toContain("Last email");
  expect(viewer).toContain("Tue 3 Nov");
  expect(viewer).toContain("None yet");
});

test("a value from a list is escaped on screen", () => {
  const html = page("owner", "people");
  expect(html).not.toContain("<b>Acme</b>");
  expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
});

test("only an editor can move the dates", () => {
  // Pause sits in the header's menu, which the Campaign DOM test opens.
  expect(page("viewer", "people")).not.toContain("Move dates");
  expect(page("owner", "people")).toContain("Move dates");
  // What the Campaign has done reads on Overview now, so there is no Results tab to open.
  expect(page("owner", "people")).not.toContain(">Results<");
});

test("only a connected mail account is offered as a Mailbox, and having none says what to do", async () => {
  vi.spyOn(api, "GET").mockImplementation((async (path: string) =>
    path.endsWith("/mailbox-providers")
      ? { data: { providers: [{ connection: "google" }] } }
      : { data: { credentials: [{ id: "a", name: "A model key", connection: null }, { id: "b", name: "sam@acme.test", connection: "google" }, { id: "c", name: "Acme Page", connection: "some_network" }] } }) as never);
  expect((await mailboxes(W)).map((c) => c.id)).toEqual(["b"]);
  const html = renderToString(withQueries(createElement(Campaign, { workspaceId: W, id: ID, role: "owner", tab: "drafts", initial: { campaign, boxes: [] } })));
  expect(html).toContain("No email account is connected yet");
});

const withTemplate = (over: Partial<Step> = {}): Step => ({ ...campaign.steps[0]!, templateRevision: 1, template: { subject: "Hi {{firstName}}", text: "Hello", warnings: [], needsDecision: [] }, ...over });
const stepPage = (step: Step, edit: boolean, initialPreview?: DraftsPreview) => renderToString(withQueries(createElement(TemplateStep, { workspaceId: W, id: ID, step, edit, onChange: () => {}, initialPreview })));
const PREVIEW: DraftsPreview = { willMake: 2, already: 0, leftOut: [{ email: "x@y.co", leftOut: { reason: "not_eligible", fields: ["no basis recorded"] } }], sample: { email: "kim@acme.test", subject: "Hi <b>Kim</b>", text: "Hello" } };

test("each email step picks how it is written, only an editor can change it, and a template step shows its email", () => {
  expect(page("owner", "drafts")).toContain("Written as");
  expect(page("viewer", "drafts")).not.toContain("Written as");
  const answered = renderToString(withQueries(createElement(Campaign, { workspaceId: W, id: ID, role: "owner", tab: "drafts", initial: { campaign: { ...campaign, steps: campaign.steps.map((s) => ({ ...s, draftingMode: "template" as const })) }, boxes: [] } })));
  expect(answered).not.toContain("One email per address, or one template?");
  expect(answered).toContain("Save email");
});

test("the launch shows to everyone, and only an editor can preview moving it or tie it to a step", () => {
  expect(page("viewer", "drafts")).toContain("Launch: <!-- -->Sun 1 Nov");
  expect(page("viewer", "drafts")).not.toContain("Preview");
  expect(page("owner", "drafts")).toContain("Move the launch to");
  const withPageEl = withQueries(createElement(Campaign, { workspaceId: W, id: ID, role: "owner", tab: "drafts", initial: { campaign: { ...campaign, anchor: { on: "2026-11-01", stepKey: "page" }, steps: [{ ...page0, ...unlinked }, { ...email0, ...unlinked }] }, boxes: [] } }));
  const withPage = renderToString(withPageEl);
  // The launch form sits in a drawer, closed at first, so its choices are read from the form itself.
  expect(selectOptions(withQueries(createElement(LaunchLine, { workspaceId: W, id: ID, campaign: { ...campaign, anchor: { on: "2026-11-01", stepKey: "page" }, steps: [{ ...page0, ...unlinked }, { ...email0, ...unlinked }] }, edit: true, onChange: () => {} })))["Launch when"]?.options).toContain("Launch page goes live");
  expect(withPage).toContain("or when &quot;Launch page&quot; goes live, if that&#x27;s later");
});

test("a step's progress reads as one line", () => {
  expect(progressLine({ stepKey: "first", title: "First", mode: "per_person", written: 42, toWrite: 158, readyOn: "2026-11-12", waiting: [{ label: "the landing page", count: 3 }] })).toBe("42 of 200 written · ready Thu 12 Nov · 3 waiting on the landing page");
  expect(progressLine({ stepKey: "first", title: "First", mode: "template", written: 5, toWrite: 0, readyOn: null, waiting: [] })).toBe("5 of 5 written");
  expect(progressLine({ stepKey: "first", title: "First", mode: "template", written: 0, toWrite: 0, readyOn: null, waiting: [] })).toBe("");
});

test("Make drafts states the count and who was left out, escapes the sample, and a viewer can't press it", () => {
  const html = stepPage(withTemplate(), true, PREVIEW);
  expect(html).toContain("Make <!-- -->2 drafts");
  expect(html).toContain("no basis recorded");
  expect(html).not.toContain("<b>Kim</b>");
  expect(stepPage(withTemplate(), false, PREVIEW)).not.toContain("Make ");
});

test("one draft reads as one, and an open decision hides Make drafts", () => {
  expect(stepPage(withTemplate(), true, { ...PREVIEW, willMake: 1 })).toContain("1 draft");
  const open = stepPage(withTemplate({ template: { subject: "s", text: "t", warnings: [], needsDecision: [{ code: "price_conflict", text: 'No price Fact says "$3"' }] } }), true, PREVIEW);
  expect(open).toContain("Needs a decision");
  expect(open).not.toContain("Make ");
});

test("each drafting action calls its endpoint and returns a refusal", async () => {
  const get = vi.spyOn(api, "GET").mockResolvedValue({ error: { error: "sender_identity_missing" } } as never);
  expect(await draftsPreview(W, ID, "first")).toEqual({ error: "sender_identity_missing" });
  expect(get.mock.calls.at(-1)![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/drafts-preview");
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { runId: "r" } } as never);
  expect(await startStepDraft(W, ID, "first")).toEqual({ runId: "r" });
  expect(post.mock.calls.at(-1)![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/draft-run");
  post.mockResolvedValue({ data: { results: [] } } as never);
  expect(await makeDrafts(W, ID, "first", "UTC")).toEqual({ results: [] });
  expect(post.mock.calls.at(-1)![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/make-drafts");
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: { revision: 2, revised: 0, failed: [] } } as never);
  expect(await saveTemplate(W, ID, "first", { revision: 1, subject: "s", text: "t" })).toMatchObject({ revision: 2 });
  expect(put.mock.calls.at(-1)![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/template");
  put.mockResolvedValue({ data: {} } as never);
  expect(await setDraftingMode(W, ID, "template")).toBeNull();
  expect(put.mock.calls.at(-1)![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/drafting-mode");
});

const PERSON_PREVIEW: PersonPreview = { willWrite: 3, generic: 1, already: 0, leftOut: [], worstCaseCents: 300, days: 1 };
const personDraft = (over: Partial<PersonDraft> = {}): PersonDraft => ({ personId: "p", itemId: "i", email: "kim@acme.test", state: "draft", editable: true, warnings: [{ code: "foreign_link", text: 'Needs a decision: A link no Fact or plan holds: "https://evil.test"' }, { code: "recipient_detail", text: "Says about them: <b>x</b> (from https://acme.test/)" }], subject: "Hi", text: "Hello <i>Kim</i>", spans: null, ...over });
const personPage = (edit: boolean, drafts: PersonDraft[] = []) => renderToString(createElement(PersonStep, { workspaceId: W, id: ID, step: campaign.steps[0]!, edit, initial: { preview: PERSON_PREVIEW, drafts } }));

test("per-address mode can be chosen, and states the count, cost, time and how many are general", () => {
  expect(page("owner", "drafts")).not.toContain("Not built yet");
  const html = personPage(true);
  expect(html).toContain("Write <!-- -->3 emails");
  expect(html).toContain("3.00");
  expect(html).toContain("1 email will be general, with no website to read");
  expect(personPage(false)).not.toContain("<button");
});

test("a draft shows what it says and from where, escaped, and a locked one says how to free it", () => {
  const html = personPage(true, [personDraft()]);
  expect(html).toContain("Fix and send kim@acme.test for approval");
  expect(html).toContain("from https://acme.test/");
  expect(html).not.toContain("<b>x</b>");
  expect(html).not.toContain("<i>Kim</i>");
  // A sent draft has no form of its own; the step's writer notes stay editable.
  expect(personPage(true, [personDraft({ state: "sent", editable: false })])).not.toContain("Save kim@acme.test");
  expect(personPage(true, [personDraft({ state: "sent", editable: false })])).not.toContain("Fix and send kim@acme.test");
  expect(personPage(false, [personDraft()])).not.toContain("<textarea");
});

test("the per-address actions call their endpoints", async () => {
  const get = vi.spyOn(api, "GET").mockResolvedValue({ data: { drafts: [] } } as never);
  expect(await personDrafts(W, ID, "first")).toEqual([]);
  expect(get.mock.calls.at(-1)![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/person-drafts");
  get.mockResolvedValue({ error: { error: "wrong_mode" } } as never);
  expect(await personPreview(W, ID, "first")).toEqual({ error: "wrong_mode" });
  expect(get.mock.calls.at(-1)![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/person-preview");
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { started: 1, runIds: ["r"], failed: [] } } as never);
  expect(await writePerPerson(W, ID, "first", "UTC")).toEqual({ started: 1, runIds: ["r"], failed: [] });
  expect(post.mock.calls.at(-1)![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/write-per-person");
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: {} } as never);
  expect(await editPersonDraft(W, ID, "first", "p", { subject: "s", text: "t" })).toBeNull();
  expect(put.mock.calls.at(-1)![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/people/{personId}/draft");
});

test("someone in two campaigns offers both answers to an editor, and calls approve with the choice", async () => {
  const html = page("owner", "people");
  expect(html).toContain("Skip kim@acme.test");
  expect(html).toContain("after the other ends");
  expect(page("viewer", "people")).not.toContain("Skip kim@acme.test");
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: {} } as never);
  expect(await settleConflict(W, { itemId: "c", revision: 1 }, "skip")).toBeNull();
  expect(post.mock.calls.at(-1)![1]).toMatchObject({ body: { revision: 1, choice: "skip" } });
  expect(await setCampaignPaused(W, ID, true)).toBeNull();
  expect(post.mock.calls.at(-1)![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/pause");
  expect(await setCampaignPaused(W, ID, false)).toBeNull();
  expect(post.mock.calls.at(-1)![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/resume");
});

test("each row result says what happened", () => {
  expect(sayRow({ row: 1, ok: true, missing: [] })).toBe("Row 1: added.");
  expect(sayRow({ row: 2, ok: true, missing: ["basis"] })).toContain("no draft until these are recorded: basis");
  expect(sayRow({ row: 3, ok: false, reason: "bad_email" })).toBe("Row 3: not added, not an email address.");
});

test("a Campaign whose plan isn't approved says so in words when it refuses People, steps or settings", () => {
  expect(say("plan_not_approved")).toBe("This campaign's plan isn't approved yet. People, steps and settings wait until it is.");
});

test("each action calls its endpoint", async () => {
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { results: [] } } as never);
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: {} } as never);
  const del = vi.spyOn(api, "DELETE").mockResolvedValue({ data: {} } as never);
  expect(await addPeople(W, ID, "email\na@b.co")).toEqual({ results: [] });
  expect(post.mock.calls[0]![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/people");
  expect(await saveStep(W, ID, "first", { type: "manual", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" })).toBeNull();
  expect(put.mock.calls[0]![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/steps/{key}");
  expect(await removePerson(W, ID, "p")).toBeNull();
  expect(del.mock.calls[0]![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/people/{personId}");
});

const post = { id: "p", itemId: "00000000-0000-4000-8000-000000000009", clipId: null, connection: "later", network: "Later", accountName: null, mode: "manual" as const, text: "<b>By hand</b>", video: null, images: [], url: null, followUps: [], state: "needs_approval", reason: null, revision: 1, clean: true, warnings: [], at: null };
const postStep = (state: string) =>
  renderToString(withQueries(createElement(PostStep, { workspaceId: W, id: ID, step: campaign.steps[0]!, edit: true, approve: true, initial: { accounts: [], networks: [], posts: [{ ...post, state }] } })));

test("copy and paste can be copied and marked only after approval, and what's on screen is escaped", () => {
  const before = postStep("needs_approval");
  expect(before).not.toContain("Copy text");
  expect(before).not.toContain("Mark as posted by you");
  expect(before).toContain("Approve");
  expect(before).toContain("&lt;b&gt;By hand");
  const after = postStep("scheduled");
  expect(after).toContain("Copy text");
  expect(after).toContain("Mark as posted by you");
  expect(postStep("applied")).toContain("Posted by you");
  expect(postStep("applied")).not.toContain("Copy text");
});

test("every network that can't publish is offered by hand, and connected publishing accounts aren't", () => {
  const net = (connection: string, publishes: boolean) => ({ connection, label: connection, publishes }) as never;
  const acct = { credentialId: "c", networkId: "n", network: "Blue", name: "Ana", connection: "blue", canDo: [{ feature: "follow_ups", status: "available" }] } as never;
  const c = choices([acct], [net("blue", true), net("later", false), net("unconnected", true)]);
  expect(c.map((x) => [x.connection, x.hand])).toEqual([["blue", false], ["later", true]]);
  expect(c[0]!.followUps).toBe(true);
});

test("a per-person campaign asks the website question of an Owner, and offers auto-approve for unread emails only after a yes", () => {
  const perPerson = (outsideContentAllowed: boolean, role: "owner" | "viewer" = "owner") =>
    renderToString(withQueries(createElement(Campaign, { workspaceId: W, id: ID, role, tab: "drafts", initial: { campaign: { ...campaign, outsideContentAllowed, steps: campaign.steps.map((s) => ({ ...s, draftingMode: "per_person" as const })) }, boxes: [] } })));
  expect(perPerson(false)).toContain("may go out under auto-approve without anyone reading them");
  expect(perPerson(false)).not.toContain("Set up auto-approve for emails no one reads");
  expect(perPerson(true)).toContain("Set up auto-approve for emails no one reads");
  expect(perPerson(true)).toContain("mode=agent_written");
  expect(perPerson(true, "viewer")).not.toContain("without anyone reading them");
  expect(perPerson(true, "viewer")).not.toContain("Set up auto-approve for emails no one reads");
});

test("the Content tab offers run with its model cost, to an Owner or Admin only", () => {
  const drafts = (role: "owner" | "marketer", advance: "offer" | "run" = "offer") =>
    renderToString(withQueries(createElement(Campaign, { workspaceId: W, id: ID, role, tab: "drafts", initial: { campaign: { ...campaign, advance }, boxes: [] } })));
  // The checkbox just before the run label.
  const box = (html: string) => html.match(/<input[^>]*>(?=(?:<!-- -->| )*Start next steps)/)![0];
  expect(drafts("owner")).toContain("Model cost before anyone approves: up to $1.00.");
  expect(box(drafts("owner"))).not.toContain("disabled");
  expect(box(drafts("owner"))).not.toContain("checked");
  expect(box(drafts("marketer"))).toContain("disabled");
  expect(box(drafts("owner", "run"))).toContain("checked");
});

test("a DM step says Direx never sends it, offers copy and mark sent to an editor, and escapes the text", () => {
  const step: Step = { ...campaign.steps[0]!, key: "dm", type: "dm", dmChannel: "linkedin", template: { subject: "", text: "Hi {{firstName}}", warnings: [], needsDecision: [] } };
  const dm = { id: "00000000-0000-4000-8000-0000000000d1", personId: people[0]!.personId, channel: "linkedin", profileUrl: "https://www.linkedin.com/in/kim", text: "Hi <b>Kim</b>", copiedAt: null, sentAt: null };
  const edit = renderToString(createElement(DmStep, { workspaceId: W, id: ID, step, edit: true, initial: [dm] }));
  expect(edit).toContain("You send each of these yourself on LinkedIn. Direx drafts them and never sends one.");
  expect(edit).toContain("Copy and open profile");
  expect(edit).toContain("Mark sent");
  expect(edit).toContain("Hi &lt;b&gt;Kim&lt;/b&gt;");
  expect(edit).not.toMatch(/approv/i);
  const view = renderToString(createElement(DmStep, { workspaceId: W, id: ID, step, edit: false, initial: [{ ...dm, sentAt: "2026-11-06T10:00:00.000Z" }] }));
  expect(view).not.toContain("Copy and open profile");
  expect(view).toContain("Sent ");
  const drafts = renderToString(withQueries(createElement(Campaign, { workspaceId: W, id: ID, role: "viewer", tab: "drafts", initial: { campaign: { ...campaign, draftingMode: "template", steps: [step] }, boxes: [], people } })));
  expect(drafts).toContain("LinkedIn DM you send yourself");
  expect(drafts).toContain("Direx drafts them and never sends one.");
});

test("the DM actions call their endpoints", async () => {
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { direxTouchNear: true, results: [] } } as never);
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: { revision: 1, warnings: [] } } as never);
  expect(await saveDmText(W, ID, "dm", { revision: 0, text: "Hi" })).toEqual({ revision: 1, warnings: [] });
  expect(put.mock.calls[0]![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/dm-text");
  await makeDms(W, ID, "dm");
  expect(post.mock.calls[0]![0]).toBe("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/dms");
  expect(await copyDm(W, "d")).toMatchObject({ direxTouchNear: true });
  expect(post.mock.calls[1]![0]).toBe("/api/w/{workspaceId}/campaigns/dms/{dmId}/copied");
  expect(await markDmSent(W, "d")).toBeNull();
  expect(post.mock.calls[2]![0]).toBe("/api/w/{workspaceId}/campaigns/dms/{dmId}/mark-sent");
  vi.restoreAllMocks();
});

test("People already in a conversation are counted once above the left-out list, in words", () => {
  const leftOut = [
    { email: "a@acme.test", leftOut: { reason: "not_eligible", fields: ["may_be_talking"] } },
    { email: "b@acme.test", leftOut: { reason: "not_eligible", fields: ["in_conversation"] } },
    { email: "c@acme.test", leftOut: { reason: "replied" } },
  ];
  expect(talkingLine(leftOut, 200)).toBe("You're already talking to 2 of these 200; they won't be drafted.");
  expect(talkingLine(leftOut.slice(2), 200)).toBeNull();
  expect(sayLeftOut(leftOut[0]!.leftOut)).toBe("you may already be talking to them");
  expect(sayLeftOut({ reason: "not_eligible", fields: ["no_basis"] })).toBe("can't be emailed (no_basis)");
});

test("the no-CRM notice shows on an unsent cold campaign and hides once a hold webhook exists", () => {
  const fresh = { ...campaign, sent: 0 };
  const view = (hook: { id: string; path: string; createdAt: string } | null) =>
    renderToString(withQueries(createElement(Campaign, { workspaceId: W, id: ID, role: "owner", tab: "drafts", initial: { campaign: fresh, boxes: [], people, hook } })));
  expect(view(null)).toContain("Direx can&#x27;t see your deals");
  expect(view(null)).toContain(`/w/${W}/settings/sending#hold-hook`);
  expect(view({ id: ID, path: "/api/hooks/holds/x/y", createdAt: "2026-11-08T00:00:00.000Z" })).not.toContain("see your deals");
  expect(blindToDeals(campaign)).toBe(false);
  expect(blindToDeals({ ...fresh, steps: fresh.steps.map((s) => ({ ...s, touchClass: "sales_follow_up" })) })).toBe(false);
});

test("a line diff keeps shared lines and marks the rest removed or added", () => {
  expect(lineDiff("Hi\nOld line\nBye", "Hi\nNew line\nBye")).toEqual([
    { kind: "same", line: "Hi" },
    { kind: "removed", line: "Old line" },
    { kind: "added", line: "New line" },
    { kind: "same", line: "Bye" },
  ]);
});

test("a cancelled email step says so, and offers no text to edit or drafts to approve", () => {
  const render = (cancelled: boolean) =>
    renderToString(withQueries(createElement(Campaign, { workspaceId: W, id: ID, role: "owner", tab: "drafts", initial: { campaign: { ...campaign, steps: campaign.steps.map((s) => ({ ...s, draftingMode: "template" as const, cancelled })) }, boxes: [] } })));
  expect(buttons(render(false), "Save email")).toHaveLength(1);
  const html = render(true);
  expect(html).toContain("Cancelled. Its unsent emails were cancelled too.");
  expect(buttons(html, "Save email")).toHaveLength(0);
});

test("a step the plan changed shows the text diff, the expired slots and three choices; a viewer only reads", () => {
  const changed: Loaded = {
    ...campaign,
    steps: [
      {
        ...campaign.steps[0]!,
        template: { subject: "Hi", text: "Old <b>words</b>", warnings: [], needsDecision: [] },
        planChange: { kinds: ["text"], suggestedTemplate: { subject: "Hi", text: "New words" }, itemId: "00000000-0000-4000-8000-0000000000ee", expired: 2 },
      },
    ],
  };
  const render = (role: "owner" | "viewer") => renderToString(withQueries(createElement(Campaign, { workspaceId: W, id: ID, role, tab: "drafts", initial: { campaign: changed, boxes: [], people } })));
  const owner = render("owner");
  expect(owner).toContain("The plan changed this step. Its emails wait until you choose.");
  expect(owner).toContain("<del>Old &lt;b&gt;words&lt;/b&gt;</del>");
  expect(owner).toContain("<ins>New words</ins>");
  expect(owner).toContain("2 emails will move to the next free slots");
  for (const label of ["Keep the current text", "Use the new text", "Cancel the step"]) expect(buttons(owner, label)).toHaveLength(1);
  const viewer = render("viewer");
  expect(viewer).toContain("The plan changed this step.");
  expect(buttons(viewer, "Use the new text")).toHaveLength(0);
});

test("the plan's impact says how many steps it holds and what each change does", () => {
  const impact: Impact = {
    diff: {
      steps: [
        { key: "first", kind: "changed" as const, redatedDays: 2, retitled: false, channel: false, text: true },
        { key: "webinar", kind: "changed" as const, redatedDays: -1, retitled: true, channel: false, text: false },
        { key: "post", kind: "added" as const },
        { key: "old", kind: "removed" as const },
      ],
      plan: ["goal" as const, "audience" as const],
    },
    affected: [
      { key: "first", kinds: ["text" as const], counts: { scheduled: 42, held: 3, sent: 5 } },
      { key: "old", kinds: ["removed" as const], counts: {} },
    ],
    titles: { first: "First email", webinar: "Webinar invite", old: "Old step" },
  };
  const html = renderToString(createElement(PlanImpact, { workspaceId: W, planId: "p", refresh: 0, initial: { campaignId: ID, impact } }));
  expect(html).toContain("Affects 2 steps and 45 unsent emails (Scheduled: 42, Held: 3). They wait until you choose for each step.");
  expect(html).toContain("First email: text suggested, 2 days later");
  expect(html).toContain("Webinar invite: 1 day earlier, retitled");
  // A step with no title on record falls back to its key.
  expect(html).toContain("post: added");
  expect(html).toContain("Old step: removed");
  expect(html).toContain("Goal changed");
  expect(html).toContain("Who it&#x27;s for changed: check who&#x27;s in this Campaign");
  const quiet = renderToString(createElement(PlanImpact, { workspaceId: W, planId: "p", refresh: 0, initial: { campaignId: ID, impact: { diff: { steps: [], plan: [] }, affected: [], titles: {} } } }));
  expect(quiet).toBe("");
});
