// SPDX-License-Identifier: AGPL-3.0-only
// The People tab: who is in the campaign, adding them (a list file, one person, or pasted CSV), and
// what drafting them will take. Every way in sends the same CSV to the same import.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { EmptyState, Notice } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { EllipsisIcon } from "lucide-react";
import { Input, Select, Textarea } from "@/components/Input";
import { Field } from "../components/layout";
import { COUNTRIES } from "../outreach/countries";
import { BASIS_WORDS, type Basis } from "../outreach/actions";
import { toast } from "@/components/toast";
import { useAction } from "../components/useAction";
import { SENDER_COUNTRY_NOTE, warningWords } from "../outreach/actions";
import { addPeople, CAMPAIGN_MESSAGES, confirmDrafting, dayWords, draftingPreview, peoplePage, peopleQuery, removePerson, say, sayRow, settleConflict, type DraftingPreview, type Person, type RowResult } from "./actions";

/** Direx's columns a list's own columns can be matched to. Email is the only one required. */
export const FIELDS = [
  ["email", "Email"],
  ["first_name", "First name"],
  ["company", "Company"],
  ["website", "Website"],
  ["country", "Country"],
] as const;
type FieldKey = (typeof FIELDS)[number][0];
export type Mapping = Record<FieldKey, number>;
const GUESS: Record<FieldKey, RegExp> = {
  email: /e-?mail/i,
  first_name: /^(first[ _-]?name|first|name|given[ _-]?name)$/i,
  company: /company|organi[sz]ation|business|account/i,
  website: /website|url|domain|site/i,
  country: /country/i,
};
// Columns Direx already reads under these names pass through as they are.
const KEEP = ["basis", "evidence", "entity_type", "scope", "expires"];

/** A CSV's records, by the same strict rules as the API's reader; null for a stray quote. */
export function readCsv(text: string): string[][] | null {
  const out: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') {
      if (field || wasQuoted) return null;
      quoted = wasQuoted = true;
    } else if (ch === "," || ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      wasQuoted = false;
      if (ch !== ",") {
        out.push(record);
        record = [];
      }
    } else {
      if (wasQuoted) return null;
      field += ch;
    }
  }
  if (quoted) return null;
  if (field || wasQuoted || record.length) out.push([...record, field]);
  return out.filter((r) => r.length > 1 || r[0] !== "");
}

/** Which of a list's columns holds each of Direx's, guessed from the column names; -1 for none. */
export const guessMapping = (header: string[]): Mapping =>
  Object.fromEntries(FIELDS.map(([key]) => [key, header.findIndex((h) => GUESS[key].test(h.trim()))])) as Mapping;

const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
const byName = new Map(COUNTRIES.map((c) => [c.name.toLowerCase(), c.code]));
/** A country as its two-letter code: "gb" and "United Kingdom" both become "GB". Anything else stays, for the import to name. */
export const countryCode = (v: string) => (/^[a-z]{2}$/i.test(v.trim()) ? v.trim().toUpperCase() : (byName.get(v.trim().toLowerCase()) ?? v));

/**
 * The list rewritten under Direx's column names, ready for the import. `all` gives every row one
 * reason to contact them and where it came from, in place of any such columns in the file.
 */
export function mapCsv(rows: string[][], map: Mapping, all?: { basis: Basis; evidence: string }): string {
  const [header = [], ...body] = rows;
  const named = header.map((h) => h.trim().toLowerCase());
  const mapped = FIELDS.filter(([key]) => map[key] >= 0).map(([key]) => [key, map[key]] as const);
  const kept = KEEP.filter((k) => !(all && (k === "basis" || k === "evidence"))).flatMap((k) => (named.includes(k) ? [[k, named.indexOf(k)] as const] : []));
  const columns = [...mapped, ...kept];
  const out = [[...columns.map(([k]) => k), ...(all ? ["basis", "evidence"] : [])]];
  for (const r of body) {
    // A row with the wrong number of columns goes on short, so the import reports it as it would have.
    if (r.length !== header.length) out.push([""]);
    else out.push([...columns.map(([k, i]) => (k === "country" ? countryCode(r[i]!) : r[i]!)), ...(all ? [all.basis, all.evidence] : [])]);
  }
  return out.map((r) => r.map(cell).join(",")).join("\n");
}

/** A person's place in the campaign, in words. */
const STATUS_WORDS: Record<string, string> = { active: "In the campaign", replied: "Replied", removed: "Removed", conflict: "In another campaign" };

export function People(p: { workspaceId: string; id: string; edit: boolean; initial?: Person[] }) {
  const client = useQueryClient();
  const first = useQuery({ ...peopleQuery(p.workspaceId, p.id), initialData: p.initial && { people: p.initial, next: null } });
  // Pages after the first, from Show more; a reload starts from the first page again.
  const [more, setMore] = useState<{ people: Person[]; next: string | null }>();
  const [results, setResults] = useState<RowResult[]>([]);
  const [error, setError] = useState<string>();
  const [drafting, setDrafting] = useState<DraftingPreview>();
  const adding = useAction();
  const confirming = useAction();
  const showing = useAction();
  // One row change at a time; the key names the button that is busy.
  const changing = useAction();
  const [busyKey, setBusyKey] = useState<string>();
  const change = (key: string, act: () => Promise<string | null>) => {
    setBusyKey(key);
    void changing.run(async () => {
      const failed = await act();
      setError(failed ? say(failed) : undefined);
      await reload();
      return null;
    });
  };
  const busy = (key: string) => ({ pending: changing.pending && busyKey === key, disabled: changing.pending });
  const reload = async () => {
    setMore(undefined);
    await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
  };
  const [adder, setAdder] = useState<"list" | "one">();
  /** Imports a CSV, shows each row's result and what drafting them takes; true when the import ran. */
  const add = async (csv: string) => {
    let ok = false;
    await adding.run(async () => {
      const r = await addPeople(p.workspaceId, p.id, csv);
      setError("error" in r ? say(r.error) : undefined);
      if ("error" in r) return null;
      ok = true;
      setResults(r.results);
      await reload();
      // Importing is when drafting costs runs, so say what it takes before anything starts.
      const d = await draftingPreview(p.workspaceId, p.id);
      setDrafting("error" in d ? undefined : d);
      return null;
    });
    return ok;
  };
  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}
      {p.edit && (
        <div className="flex flex-col items-start gap-3">
          <div className="flex flex-wrap gap-2">
            <Button variant={adder === "list" ? "default" : "outline"} aria-expanded={adder === "list"} onClick={() => setAdder(adder === "list" ? undefined : "list")}>
              Import a list
            </Button>
            <Button variant={adder === "one" ? "default" : "outline"} aria-expanded={adder === "one"} onClick={() => setAdder(adder === "one" ? undefined : "one")}>
              Add one person
            </Button>
          </div>
          {adder === "list" && <ImportList pending={adding.pending} onAdd={(csv) => add(csv).then((ok) => ok && setAdder(undefined))} />}
          {adder === "one" && <AddOne pending={adding.pending} onAdd={(csv) => add(csv).then((ok) => ok && setAdder(undefined))} />}
          <details className="w-full">
            <summary className="cursor-pointer text-sm text-muted-foreground">Paste a CSV instead</summary>
            <form
              className="mt-3 flex flex-col items-start gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                if (await add(new FormData(form).get("csv") as string)) form.reset();
              }}
            >
              <div className="flex w-full flex-col gap-1.5">
                <Textarea
                  label="Paste a CSV."
                  hint="Put the column names in the first row. Only email is needed to add someone; first_name, company and website help Direx write to them. Before anyone gets a draft, add country, basis (why you may email them) and evidence (where that comes from). You can also add entity_type (corporate, sole_trader, partnership or unknown), scope, and expires as YYYY-MM-DD, the day they stop getting drafts."
                  name="csv"
                  rows={6}
                  required
                  className="font-mono"
                />
              </div>
              <Button type="submit" pending={adding.pending}>
                Add people
              </Button>
            </form>
          </details>
        </div>
      )}
      {drafting && drafting.people > 0 && (
        <div role="status" className="flex flex-col items-start gap-3 rounded-card bg-muted px-4 py-3">
          <p>
            {drafting.mode === "per_person"
              ? `Writing the first email for ${drafting.people} ${drafting.people === 1 ? "person" : "people"} takes ${drafting.runs} AI runs, at most $${(drafting.worstCaseCents / 100).toFixed(2)}, ${drafting.days === null ? "but the daily run caps allow none, so it waits until they're raised" : `over about ${drafting.days} ${drafting.days === 1 ? "day" : "days"}`}.`
              : `The first email goes to ${drafting.people} ${drafting.people === 1 ? "person" : "people"} from its template, with no AI runs.`}
            {drafting.leftOut.length > 0 && ` ${drafting.leftOut.length} can't be drafted yet.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              pending={confirming.pending}
              onClick={() =>
                void confirming.run(async () => {
                  const r = await confirmDrafting(p.workspaceId, p.id, Intl.DateTimeFormat().resolvedOptions().timeZone);
                  if ("error" in r) setError(say(r.error ?? "failed"));
                  else {
                    setDrafting(undefined);
                    toast.add({ title: r.mode === "per_person" ? `Writing ${r.started} ${r.started === 1 ? "draft. It waits" : "drafts. They wait"} on Home.` : `Made ${r.made} ${r.made === 1 ? "draft. It waits" : "drafts. They wait"} on Home.` });
                  }
                  return null;
                })
              }
            >
              Write the drafts
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setDrafting(undefined)}>
              Not now
            </Button>
          </div>
        </div>
      )}
      {results.length > 0 && (
        <ul aria-label="Results by row" className="flex flex-col gap-1 text-sm">
          {results.map((r) => (
            <li key={r.row}>{sayRow(r)}</li>
          ))}
        </ul>
      )}
      <QueryBoundary query={first} skeleton={<Skeleton className="h-48 w-full" />} messages={CAMPAIGN_MESSAGES}>
        {(page) => {
          const people = [...page.people, ...(more?.people ?? [])];
          const next = more ? more.next : page.next;
          return (
            <div className="flex flex-col gap-4 rounded-card border border-border bg-card p-6">
              {people.some((x) => x.warnings.includes("sender_country_missing")) && <p className="text-muted-foreground">{SENDER_COUNTRY_NOTE}</p>}
              {people.length === 0 ? (
                <EmptyState title="No one in this campaign yet">{p.edit ? "Import a list or add one person above." : "People show here once someone adds them."}</EmptyState>
              ) : (
                <div className="overflow-x-auto">
                  <Table aria-label="People">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>Company</TableHeaderCell>
                        <TableHeaderCell>Email</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Last email</TableHeaderCell>
                        <TableHeaderCell>
                          <span className="sr-only">Actions</span>
                        </TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {people.map((x) => (
                        <TableRow key={x.personId}>
                          <TableCell>{x.firstName ?? <span className="text-muted-foreground">Not known</span>}</TableCell>
                          <TableCell className="whitespace-normal">
                            {x.company ?? <span className="text-muted-foreground">Not known</span>}
                            {x.website && <span className="block text-xs text-muted-foreground">{x.website}</span>}
                          </TableCell>
                          <TableCell>{x.email}</TableCell>
                          <TableCell className="whitespace-normal">
                            <div className="flex flex-col items-start gap-1">
                              <span>{STATUS_WORDS[x.status] ?? x.status}</span>
                              {x.blocked && x.status === "active" && <small className="text-sm text-muted-foreground">{`Gets no draft: ${x.blocked}. Record it under Outreach.`}</small>}
                              {x.status === "active" &&
                                warningWords(x, true).map((w) => (
                                  <small key={w} className="text-sm text-muted-foreground">
                                    {w}
                                  </small>
                                ))}
                              {p.edit && x.conflict && (
                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                  {(["skip", "add_after"] as const).map((choice) => (
                                    <Button
                                      key={choice}
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      {...busy(`${x.personId}:${choice}`)}
                                      onClick={() => change(`${x.personId}:${choice}`, () => settleConflict(p.workspaceId, x.conflict!, choice))}
                                    >
                                      {choice === "skip" ? `Skip ${x.email}` : `Add ${x.email} after the other ends`}
                                    </Button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="tabular-nums">{x.lastEmailAt ? dayWords(x.lastEmailAt.slice(0, 10)) : <span className="text-muted-foreground">None yet</span>}</TableCell>
                          <TableCell>
                            {p.edit && x.status !== "removed" && (
                              <DropdownMenu
                                button={{ label: `Actions for ${x.email}`, icon: <EllipsisIcon aria-hidden className="size-4" />, isIconOnly: true, variant: "ghost", size: "sm", isLoading: changing.pending && busyKey === `${x.personId}:remove` }}
                                items={[{ id: "remove", label: "Remove from this campaign", onClick: () => change(`${x.personId}:remove`, () => removePerson(p.workspaceId, p.id, x.personId)) }]}
                              />
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {next && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  pending={showing.pending}
                  onClick={() =>
                    void showing.run(async () => {
                      const got = await peoplePage(p.workspaceId, p.id, next);
                      setMore({ people: [...(more?.people ?? []), ...(got?.people ?? [])], next: got?.next ?? null });
                      return null;
                    })
                  }
                >
                  Show more
                </Button>
              )}
            </div>
          );
        }}
      </QueryBoundary>
    </>
  );
}

const BASES: Basis[] = ["published_address", "legitimate_interest", "implied", "consent"];
const csvRow = (values: string[]) => values.map(cell).join(",");

/** "Import a list": a CSV file whose columns the person matches to Direx's, with one reason for the whole list. */
function ImportList(p: { pending: boolean; onAdd: (csv: string) => void }) {
  const [file, setFile] = useState<{ name: string; rows: string[][] }>();
  const [map, setMap] = useState<Mapping>();
  const [basis, setBasis] = useState<Basis | "">("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string>();
  const header = file?.rows[0] ?? [];
  return (
    <form
      className="flex w-full flex-col gap-4 rounded-card border border-border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (file && map) p.onAdd(mapCsv(file.rows, map, basis ? { basis, evidence: evidence.trim() || `From ${file.name}` } : undefined));
      }}
    >
      <Input
        type="file"
        label="A CSV file"
        hint="Most spreadsheets and CRMs save one: File, then Download or Export as CSV."
        accept=".csv,text/csv"
        onChange={async (e) => {
          const picked = e.target.files?.[0];
          if (!picked) return;
          const rows = readCsv(await picked.text());
          if (!rows?.length) return setError("Direx couldn't read that file as a CSV. Save it from your spreadsheet as CSV and try again.");
          setError(undefined);
          setFile({ name: picked.name, rows });
          setMap(guessMapping(rows[0]!));
          setEvidence(`From ${picked.name}`);
        }}
      />
      {error && <Notice tone="error">{error}</Notice>}
      {file && map && (
        <>
          <p className="text-sm text-muted-foreground">{`${file.rows.length - 1} ${file.rows.length === 2 ? "row" : "rows"}. Match your columns:`}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map(([key, label]) => (
              <Select key={key} label={label} value={String(map[key])} required={key === "email"} onChange={(e) => setMap({ ...map, [key]: Number(e.target.value) })}>
                <option value="-1">{key === "email" ? "Choose a column" : "Not in this list"}</option>
                {header.map((h, i) => (
                  <option key={i} value={String(i)}>
                    {h || `Column ${i + 1}`}
                  </option>
                ))}
              </Select>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Why you may contact them" hint="For everyone on this list. Before anyone gets a draft, Direx needs a reason and their country." value={basis} onChange={(e) => setBasis(e.target.value as Basis | "")}>
              <option value="">Decide later</option>
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {BASIS_WORDS[b]}
                </option>
              ))}
            </Select>
            {basis && (
              <Field label="Where it came from">
                <Input value={evidence} required maxLength={500} onChange={(e) => setEvidence(e.target.value)} />
              </Field>
            )}
          </div>
          <Button type="submit" className="self-start" pending={p.pending} disabled={map.email < 0}>
            {`Import ${file.rows.length - 1} ${file.rows.length === 2 ? "person" : "people"}`}
          </Button>
        </>
      )}
    </form>
  );
}

/** "Add one person": the same import, for a single row typed in. */
function AddOne(p: { pending: boolean; onAdd: (csv: string) => void }) {
  return (
    <form
      className="flex w-full flex-col gap-4 rounded-card border border-border bg-card p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const v = (k: string) => String(f.get(k) ?? "").trim();
        const keys = ["email", "first_name", "company", "website", "country", ...(v("basis") ? ["basis", "evidence"] : [])];
        p.onAdd(`${csvRow(keys)}\n${csvRow(keys.map(v))}`);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email">
          <Input name="email" type="email" required autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="First name">
          <Input name="first_name" autoComplete="off" />
        </Field>
        <Field label="Company">
          <Input name="company" autoComplete="off" />
        </Field>
        <Field label="Website">
          <Input name="website" autoComplete="off" spellCheck={false} placeholder="example.com" />
        </Field>
        <Select label="Country" name="country" defaultValue="">
          <option value="">Choose a country</option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select label="Why you may contact them" name="basis" defaultValue="">
          <option value="">Decide later</option>
          {BASES.map((b) => (
            <option key={b} value={b}>
              {BASIS_WORDS[b]}
            </option>
          ))}
        </Select>
        <Field label="Where it came from">
          <Input name="evidence" defaultValue="Added by hand" maxLength={500} />
        </Field>
      </div>
      <Button type="submit" className="self-start" pending={p.pending}>
        Add to this campaign
      </Button>
    </form>
  );
}
