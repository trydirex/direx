// SPDX-License-Identifier: AGPL-3.0-only
// Brand's Competitors section: the list with each page, the no-changelog note, what a check found,
// the sixth add refused, and a viewer who reads but can't change.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { Competitors } from "./Competitors";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const competitor = (n: number, over: object = {}) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, name: `C${n}`, pricingUrl: null, changelogUrl: null, landingUrl: `https://c${n}.example/`, comparisonUrl: null, ...over });
const double = { ...competitor(1), name: "Double", pricingUrl: "https://doublehq.com/pricing-plans/", changelogUrl: "https://doublehq.canny.io/changelog", landingUrl: null };
const finlens = competitor(2, { name: "Finlens", landingUrl: "https://www.finlens.app/" });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Served = { list: object[]; reads?: object[]; changes?: Record<string, object[]>; facts?: object[]; found?: object };
/** The list route and each competitor's Changes route, from one table the test can change. */
const serve = (list: object[], more: Omit<Served, "list"> = {}) => {
  const table: Served = { list, ...more };
  vi.spyOn(api, "GET").mockImplementation(((path: string, init: { params: { path: { id?: string } } }) =>
    path.endsWith("/changes")
      ? reply(200, { changes: table.changes?.[init.params.path.id!] ?? [] })
      : path.endsWith("/facts")
        ? reply(200, { facts: table.facts ?? [] })
        : path.endsWith("/proposals")
          ? reply(200, table.found ?? { proposals: [], site: null, scannedAt: null })
        : reply(200, { competitors: table.list, reads: table.reads ?? [] })) as never);
  return table;
};

test("each competitor shows its pages, and one with no changelog says what that costs", async () => {
  serve([double, finlens]);
  render(withQueries(<Competitors workspaceId={W} role="viewer" />));
  const d = within(await screen.findByRole("listitem", { name: "Double" }));
  expect(d.getByText("https://doublehq.canny.io/changelog")).toBeTruthy();
  expect(d.queryByText(/No changelog/)).toBeNull();
  const f = within(screen.getByRole("listitem", { name: "Finlens" }));
  expect(f.getByText("No changelog: most answerable changes come from changelogs.")).toBeTruthy();
  // A viewer reads but has nothing to press.
  expect(screen.queryByRole("button", { name: "Check Double again" })).toBeNull();
  expect(screen.queryByRole("form", { name: "Add a competitor" })).toBeNull();
});

test("adding shows what each page gave, and Check again replaces it", async () => {
  const table = serve([]);
  const post = vi.spyOn(api, "POST").mockImplementation((() =>
    reply(200, {
      competitor: double,
      checks: [
        { source: "pricing", url: double.pricingUrl, result: "no_prices" },
        { source: "changelog", url: double.changelogUrl, result: "robots_disallowed" },
      ],
    })) as never);
  render(withQueries(<Competitors workspaceId={W} role="owner" />));
  const form = within(await screen.findByRole("form", { name: "Add a competitor" }));
  await userEvent.type(form.getByRole("textbox", { name: "Name" }), "Double");
  await userEvent.type(form.getByRole("textbox", { name: "Pricing page" }), double.pricingUrl);
  table.list = [double];
  await userEvent.click(form.getByRole("button", { name: "Add competitor" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/competitors", { params: { path: { workspaceId: W } }, body: { name: "Double", pricingUrl: double.pricingUrl, changelogUrl: "", landingUrl: "", comparisonUrl: "" } });
  const d = within(await screen.findByRole("listitem", { name: "Double" }));
  expect(await d.findByText("Readable, but no prices in the text; they may be drawn by a script")).toBeTruthy();
  expect(d.getByText("Blocked by robots.txt")).toBeTruthy();

  post.mockImplementation((() =>
    reply(200, {
      checks: [
        { source: "pricing", url: double.pricingUrl, result: "readable", prices: ["$500", "$200", "$10"] },
        { source: "changelog", url: double.changelogUrl, result: "failed", detail: "http_error 404" },
      ],
    })) as never);
  await userEvent.click(d.getByRole("button", { name: "Check Double again" }));
  expect(await d.findByText("Didn't load (http_error 404)")).toBeTruthy();
  expect(d.queryByText("Blocked by robots.txt")).toBeNull();
  // The prices found are named, so add-on prices alone show the plans are missing.
  expect(d.getByText("Readable: found $500, $200, $10. If your competitor's plan prices aren't here, they're drawn by a script")).toBeTruthy();
});

const C1 = "00000000-0000-4000-8000-0000000000c1";
const answeredLike = (sameAs: string) => ({ label: "answer", kind: "comparison_page", sameAs, reason: "The same launch." });

test("each page shows its last weekly read, and a competitor with Changes lists them behind a disclosure", async () => {
  const at = "2026-11-16T07:00:00.000Z";
  serve([double, finlens], {
    reads: [
      { competitorId: double.id, source: "changelog", url: double.changelogUrl, readAt: at, failure: null },
      { competitorId: double.id, source: "pricing", url: double.pricingUrl, readAt: at, failure: "robots_disallowed" },
      // A read of Finlens's old landing URL says nothing about its current one.
      { competitorId: finlens.id, source: "landing", url: "https://old.finlens.example/", readAt: at, failure: "failed: http_error 404" },
    ],
    changes: {
      [double.id]: [
        { id: C1, source: "changelog", detail: { added: ["Bank feeds ready for Canada"] }, at, label: "answer", kind: "comparison_page", sameAs: null, reason: "Bank feeds are LedgerMatch's ground." },
        { id: "00000000-0000-4000-8000-0000000000c2", source: "pricing", detail: { added: ["Enterprise"], removed: ["$10 per client"] }, at, label: "noise", kind: null, sameAs: null, reason: "A tier for larger firms." },
        { id: "00000000-0000-4000-8000-0000000000c3", source: "landing", detail: { part: "headline", before: "Close faster", after: "Your fully automated close is here." }, at, ...answeredLike(C1) },
        { id: "00000000-0000-4000-8000-0000000000c4", source: "changelog", detail: { rewritten: { added: 40, removed: 0 } }, at, label: null, kind: null, sameAs: null, reason: null },
        { id: "00000000-0000-4000-8000-0000000000c5", source: "changelog", detail: { added: ["Autoclose"] }, at, ...answeredLike("00000000-0000-4000-8000-00000000000f") },
      ],
    },
  });
  render(withQueries(<Competitors workspaceId={W} role="viewer" />));
  const d = within(await screen.findByRole("listitem", { name: "Double" }));
  expect(d.getByText(/^Read /)).toBeTruthy();
  expect(d.getByText("Last read failed: blocked by robots.txt")).toBeTruthy();
  const changes = within(await d.findByRole("list", { name: "Changes at Double" }));
  expect(d.getByText("Changes in the last 4 weeks (5)")).toBeTruthy();
  for (const line of ["Added: Bank feeds ready for Canada", "Added: Enterprise", "Removed: $10 per client", "Headline changed from “Close faster” to “Your fully automated close is here.”", "Page rewritten: 40 lines added, 0 removed"])
    expect(changes.getByText(line)).toBeTruthy();
  // The classifier's label, once a run has given one; an unlabelled Change shows none.
  const day = new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  expect(changes.getByText("Worth answering: comparison page. Bank feeds are LedgerMatch's ground.")).toBeTruthy();
  expect(changes.getByText("Noise. A tier for larger firms.")).toBeTruthy();
  expect(changes.getByText(`Worth answering: comparison page. The same launch. Same as the Change of ${day}.`)).toBeTruthy();
  expect(changes.getByText("Worth answering: comparison page. The same launch. Same as an earlier Change.")).toBeTruthy();
  expect(changes.getAllByText(/^(Worth answering|Noise)/)).toHaveLength(4);

  const f = within(screen.getByRole("listitem", { name: "Finlens" }));
  expect(f.queryByText(/Read |Last read/)).toBeNull();
  expect(f.queryByText(/Changes in the last/)).toBeNull();
});

test("our comparison page, what Direx knows about a competitor, and a link to each answer's counter-move", async () => {
  const at = "2026-11-16T07:00:00.000Z";
  const item = "00000000-0000-4000-8000-0000000000e1";
  serve([{ ...double, comparisonUrl: "https://contoso.example/vs-double" }], {
    facts: [
      { id: "f1", field: "competitor", subject: "double", value: "pricing page, read 16 Nov 2026: Enterprise", version: 1, source: { kind: "website", label: "Double pricing page" }, confidence: "high", usable: true },
      { id: "f2", field: "claim", subject: "double", value: "Not about them", version: 1, source: { kind: "person", label: "Sam" }, confidence: "high", usable: true },
    ],
    changes: { [double.id]: [{ id: C1, source: "changelog", detail: { added: ["Autoclose"] }, at, label: "answer", kind: "comparison_page", sameAs: null, reason: "Prices reconciliation.", itemId: item }] },
  });
  render(withQueries(<Competitors workspaceId={W} role="viewer" />));
  const d = within(await screen.findByRole("listitem", { name: "Double" }));
  expect(d.getByText("https://contoso.example/vs-double")).toBeTruthy();
  expect(await d.findByText("pricing page, read 16 Nov 2026: Enterprise")).toBeTruthy();
  expect(d.queryByText("Not about them")).toBeNull();
  const link = await d.findByRole("link", { name: "Open the counter-move" });
  expect(link.getAttribute("href")).toBe(`/w/${W}/review/${item}`);
});

test("the form takes our comparison page, and editing fills it in", async () => {
  serve([{ ...double, comparisonUrl: "https://contoso.example/vs-double" }]);
  const patch = vi.spyOn(api, "PATCH").mockImplementation((() => reply(200, { competitor: double, checks: [] })) as never);
  render(withQueries(<Competitors workspaceId={W} role="owner" />));
  await userEvent.click(await screen.findByRole("button", { name: "Edit Double" }));
  const form = within(screen.getByRole("form", { name: "Edit competitor" }));
  const field = form.getByRole("textbox", { name: "Our comparison page (optional)" });
  expect((field as HTMLInputElement).value).toBe("https://contoso.example/vs-double");
  await userEvent.clear(field);
  await userEvent.click(form.getByRole("button", { name: "Save" }));
  expect(patch).toHaveBeenCalledWith("/api/w/{workspaceId}/competitors/{id}", expect.objectContaining({ body: expect.objectContaining({ comparisonUrl: "" }) }));
});

test("with five on the list, adding is closed and says why; a refusal is put in words", async () => {
  serve([1, 2, 3, 4, 5].map((n) => competitor(n)));
  render(withQueries(<Competitors workspaceId={W} role="admin" />));
  const form = within(await screen.findByRole("form", { name: "Add a competitor" }));
  expect(form.getByText("Up to 5 competitors.")).toBeTruthy();
  await userEvent.type(form.getByRole("textbox", { name: "Name" }), "C6");
  expect(form.getByRole("button", { name: "Add competitor" }).hasAttribute("disabled")).toBe(true);

  // Editing is still open, and a refusal from the API is shown in words.
  vi.spyOn(api, "PATCH").mockImplementation((() => reply(409, { error: "name_taken" })) as never);
  await userEvent.click(screen.getByRole("button", { name: "Edit C1" }));
  const editForm = within(screen.getByRole("form", { name: "Edit competitor" }));
  await userEvent.clear(editForm.getByRole("textbox", { name: "Name" }));
  await userEvent.type(editForm.getByRole("textbox", { name: "Name" }), "C2");
  await userEvent.click(editForm.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("A competitor with that name is already on the list.")).toBeTruthy();
});

test("a competitor with no name is asked for one, without the length limit", async () => {
  serve([]);
  vi.spyOn(api, "POST").mockImplementation((() => reply(400, { error: "name_missing" })) as never);
  render(withQueries(<Competitors workspaceId={W} role="admin" />));
  fireEvent.submit(await screen.findByRole("form", { name: "Add a competitor" }));
  expect(await screen.findByText("Give the competitor a name.")).toBeTruthy();
});

const findReply = (body: object, status = 200) => vi.spyOn(api, "POST").mockImplementation(((path: string) => (path.endsWith("/find-pages") ? reply(status, body) : reply(500, { error: "unexpected" }))) as never);

test("Find pages fills only empty fields, says where each was found, and offers the rest; nothing is saved", async () => {
  serve([]);
  const post = findReply({
    ok: true,
    pricing: { url: "https://doublehq.com/pricing-plans/", via: "homepage", text: "Pricing" },
    changelog: { url: "https://doublehq.canny.io/changelog", via: "homepage", text: "Product Releases" },
    alsoPricing: ["https://doublehq.com/firm-pricing"],
  });
  render(withQueries(<Competitors workspaceId={W} role="owner" />));
  const form = within(await screen.findByRole("form", { name: "Add a competitor" }));
  const find = form.getByRole("button", { name: "Find pages" });
  expect((find as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(form.getByRole("textbox", { name: "Landing page" }), "https://doublehq.com");
  await userEvent.type(form.getByRole("textbox", { name: "Changelog" }), "https://mine.example/changes");
  await userEvent.click(find);

  const pricing = form.getByRole("textbox", { name: /^Pricing page/ }) as HTMLInputElement;
  await vi.waitFor(() => expect(pricing.value).toBe("https://doublehq.com/pricing-plans/"));
  expect(form.getByText("Found through the link “Pricing” on the homepage.")).toBeTruthy();
  expect(form.getByText("Other pricing pages: https://doublehq.com/firm-pricing")).toBeTruthy();
  const changelog = form.getByRole("textbox", { name: "Changelog" }) as HTMLInputElement;
  expect(changelog.value).toBe("https://mine.example/changes");
  expect(form.getByText("Direx found https://doublehq.canny.io/changelog")).toBeTruthy();
  await userEvent.click(form.getByRole("button", { name: "Use the found changelog" }));
  expect(changelog.value).toBe("https://doublehq.canny.io/changelog");
  expect(form.queryByText(/^Direx found/)).toBeNull();

  // Editing a filled page makes it the person's: the note goes.
  fireEvent.change(pricing, { target: { value: "https://doublehq.com/other" } });
  expect(form.queryByText(/^Found through/)).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/competitors/find-pages", { params: { path: { workspaceId: W } }, body: { landingUrl: "https://doublehq.com" } });
});

test("pages found in the sitemap or through the roadmap say so", async () => {
  serve([]);
  findReply({ ok: true, pricing: { url: "https://acme.example/plans", via: "sitemap", text: "" }, changelog: { url: "https://roadmap.acme.example/announcements", via: "roadmap", text: "" }, alsoPricing: [] });
  render(withQueries(<Competitors workspaceId={W} role="owner" />));
  const form = within(await screen.findByRole("form", { name: "Add a competitor" }));
  await userEvent.type(form.getByRole("textbox", { name: "Landing page" }), "https://acme.example");
  await userEvent.click(form.getByRole("button", { name: "Find pages" }));
  expect(await form.findByText("Found in the site's sitemap.")).toBeTruthy();
  expect(form.getByText("Found through a link on the roadmap page.")).toBeTruthy();
});

test.each([
  [{ ok: false, reason: "other_site" }, 200, "This address goes to another company's site, so Direx has nothing to suggest."],
  [{ ok: false, reason: "robots_disallowed" }, 200, "This site's robots.txt asks Direx not to read it."],
  [{ ok: true, pricing: null, changelog: null, alsoPricing: [] }, 200, "No pricing page or changelog found. Add them by hand if they exist."],
  [{ error: "busy" }, 409, "Already looking. Try again in a moment."],
  [{ error: "boom" }, 500, "Direx couldn't look just now. Try again."],
])("Find pages that finds nothing says why (%#)", async (body, status, words) => {
  serve([]);
  findReply(body, status);
  render(withQueries(<Competitors workspaceId={W} role="owner" />));
  const form = within(await screen.findByRole("form", { name: "Add a competitor" }));
  await userEvent.type(form.getByRole("textbox", { name: "Landing page" }), "https://keeper.app");
  await userEvent.click(form.getByRole("button", { name: "Find pages" }));
  expect(await form.findByText(words)).toBeTruthy();
  expect((form.getByRole("textbox", { name: /^Pricing page/ }) as HTMLInputElement).value).toBe("");
});

test("a second Find pages clears the pages the first one filled, but not a page the person typed", async () => {
  serve([]);
  const post = findReply({ ok: true, pricing: { url: "https://doublehq.com/pricing-plans/", via: "homepage", text: "Pricing" }, changelog: null, alsoPricing: [] });
  render(withQueries(<Competitors workspaceId={W} role="owner" />));
  const form = within(await screen.findByRole("form", { name: "Add a competitor" }));
  const landing = form.getByRole("textbox", { name: "Landing page" });
  await userEvent.type(landing, "https://doublehq.com");
  await userEvent.type(form.getByRole("textbox", { name: "Changelog" }), "https://mine.example/changes");
  await userEvent.click(form.getByRole("button", { name: "Find pages" }));
  const pricing = form.getByRole("textbox", { name: /^Pricing page/ }) as HTMLInputElement;
  await vi.waitFor(() => expect(pricing.value).toBe("https://doublehq.com/pricing-plans/"));

  post.mockImplementation((() => reply(200, { ok: false, reason: "other_site" })) as never);
  fireEvent.change(landing, { target: { value: "https://keeper.app" } });
  await userEvent.click(form.getByRole("button", { name: "Find pages" }));
  expect(await form.findByText("This address goes to another company's site, so Direx has nothing to suggest.")).toBeTruthy();
  expect(pricing.value).toBe("");
  expect((form.getByRole("textbox", { name: "Changelog" }) as HTMLInputElement).value).toBe("https://mine.example/changes");
});

const found = (over: object = {}) => ({ id: "00000000-0000-4000-8000-0000000000b1", name: "Botkeeper", site: "https://www.botkeeper.com/", comparisonUrl: "https://acme.example/botkeeper-alternative", source: "own_site", terms: null, foundAt: "2026-11-20T10:00:00.000Z", ...over });
const scanned = { site: "https://acme.example/", scannedAt: "2026-11-20T10:00:00.000Z" };

test("a proposed competitor fills the form with Use, and adding sends the proposal it came from", async () => {
  const table = serve([], { found: { proposals: [found(), found({ id: "00000000-0000-4000-8000-0000000000b2", name: "Double", site: null, comparisonUrl: null, source: "search", terms: ["bank rec software"] })], ...scanned } });
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, { competitor: double, checks: [] })) as never);
  render(withQueries(<Competitors workspaceId={W} role="owner" />));
  const proposed = within(await screen.findByRole("region", { name: "Proposed competitors" }));
  expect(proposed.getByRole("link", { name: "Your page compares you" }).getAttribute("href")).toBe("https://acme.example/botkeeper-alternative");
  expect(proposed.getByText("Search: bank rec software")).toBeTruthy();
  await userEvent.click(proposed.getByRole("button", { name: "Use Botkeeper" }));
  const form = within(screen.getByRole("form", { name: "Add a competitor" }));
  expect((form.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Botkeeper");
  expect((form.getByRole("textbox", { name: "Landing page" }) as HTMLInputElement).value).toBe("https://www.botkeeper.com/");
  expect((form.getByRole("textbox", { name: "Our comparison page (optional)" }) as HTMLInputElement).value).toBe("https://acme.example/botkeeper-alternative");
  expect(post).not.toHaveBeenCalled();
  table.found = { proposals: [], ...scanned };
  await userEvent.click(form.getByRole("button", { name: "Add competitor" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/competitors", expect.objectContaining({ body: expect.objectContaining({ name: "Botkeeper", proposalId: "00000000-0000-4000-8000-0000000000b1" }) }));
  await vi.waitFor(() => expect(screen.queryByRole("region", { name: "Proposed competitors" })).toBeNull());
});

test("Dismiss and Look again call their routes; a full list disables Use; a viewer sees proposals with nothing to press", async () => {
  const five = [1, 2, 3, 4, 5].map((n) => competitor(n));
  serve(five, { found: { proposals: [found()], ...scanned } });
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, { ok: true })) as never);
  render(withQueries(<Competitors workspaceId={W} role="owner" />));
  const proposed = within(await screen.findByRole("region", { name: "Proposed competitors" }));
  expect((proposed.getByRole("button", { name: "Use Botkeeper" }) as HTMLButtonElement).disabled).toBe(true);
  expect(proposed.getByText("5 of 5 set. Remove one to add another.")).toBeTruthy();
  await userEvent.click(proposed.getByRole("button", { name: "Dismiss Botkeeper" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/competitors/proposals/{id}/dismiss", { params: { path: { workspaceId: W, id: "00000000-0000-4000-8000-0000000000b1" } } });
  await userEvent.click(screen.getByRole("button", { name: "Look on your site again" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/competitors/proposals/scan", { params: { path: { workspaceId: W } } });
  cleanup();
  serve([], { found: { proposals: [found()], ...scanned } });
  render(withQueries(<Competitors workspaceId={W} role="viewer" />));
  expect(await screen.findByText("Botkeeper")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Use Botkeeper" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Look on your site again" })).toBeNull();
});

test("a site never scanned is scanned once when the panel opens", async () => {
  serve([], { found: { proposals: [], site: "https://acme.example/", scannedAt: null } });
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, { proposals: [], ...scanned })) as never);
  render(withQueries(<Competitors workspaceId={W} role="owner" />));
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/competitors/proposals/scan", { params: { path: { workspaceId: W } } }));
  expect(post).toHaveBeenCalledTimes(1);
});

test("a rejected discovery request shows a retry message", async () => {
  serve([finlens]);
  vi.spyOn(api, "POST").mockRejectedValueOnce(new TypeError("Network error"));
  render(withQueries(<Competitors workspaceId={W} role="owner" />));
  await userEvent.click(await screen.findByRole("button", { name: "Edit Finlens" }));
  const find = screen.getByRole("button", { name: "Find pages" }) as HTMLButtonElement;
  await userEvent.click(find);
  expect(await screen.findByText("Direx couldn't look just now. Try again.")).toBeTruthy();
  expect(find.disabled).toBe(false);
});

const pendingFind = () => {
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof reply>>>();
  const post = vi.spyOn(api, "POST").mockImplementation((() => pending.promise) as never);
  const finish = () => act(async () => pending.resolve(await reply(200, {
    ok: true,
    pricing: { url: "https://www.finlens.app/pricing", via: "sitemap", text: "" },
    changelog: { url: "https://www.finlens.app/changelog", via: "sitemap", text: "" },
    alsoPricing: ["https://www.finlens.app/plans"],
  })));
  return { post, finish };
};

test.each(["switch competitor", "cancel", "change landing page"])("ignores a pending discovery after %s", async (change) => {
  const other = competitor(3, { landingUrl: finlens.landingUrl });
  serve([finlens, other]);
  const { post, finish } = pendingFind();
  render(withQueries(<Competitors workspaceId={W} role="owner" />));
  await userEvent.click(await screen.findByRole("button", { name: "Edit Finlens" }));
  await userEvent.click(screen.getByRole("button", { name: "Find pages" }));
  expect(post).toHaveBeenCalledTimes(1);

  if (change === "switch competitor") await userEvent.click(screen.getByRole("button", { name: "Edit C3" }));
  else if (change === "cancel") await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  else fireEvent.change(screen.getByRole("textbox", { name: "Landing page" }), { target: { value: "https://other.example" } });
  await finish();

  expect((screen.getByRole("textbox", { name: /^Pricing page/ }) as HTMLInputElement).value).toBe("");
  expect((screen.getByRole("textbox", { name: /^Changelog/ }) as HTMLInputElement).value).toBe("");
  expect(screen.queryByText(/^Other pricing pages:/)).toBeNull();
});

test("discovery preserves a page entered while waiting and fills the other empty field", async () => {
  serve([finlens]);
  const { finish } = pendingFind();
  render(withQueries(<Competitors workspaceId={W} role="owner" />));
  await userEvent.click(await screen.findByRole("button", { name: "Edit Finlens" }));
  await userEvent.click(screen.getByRole("button", { name: "Find pages" }));
  const pricing = screen.getByRole("textbox", { name: /^Pricing page/ }) as HTMLInputElement;
  fireEvent.change(pricing, { target: { value: "https://www.finlens.app/custom" } });
  await finish();

  expect(pricing.value).toBe("https://www.finlens.app/custom");
  expect(screen.getByText("Direx found https://www.finlens.app/pricing")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: /^Changelog/ }) as HTMLInputElement).value).toBe("https://www.finlens.app/changelog");
});
