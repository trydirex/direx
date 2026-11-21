// SPDX-License-Identifier: AGPL-3.0-only
// Customers, under Audience: who they are, importing them from a CSV (opted-in rows only) and the list.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { inWorkspace } from "../api/query";
import { EmptyState, Notice, Page } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAction } from "../components/useAction";
import { Button } from "@/components/Button";
import { Input, Textarea } from "@/components/Input";
import { dayWords } from "../campaigns/actions";
import { customersQuery, importCustomers, say, sayCustomerSkip, type CustomerImport } from "./actions";

const unknown = <span className="text-muted-foreground">Not known</span>;

export function Customers(p: { workspaceId: string; canEdit: boolean }) {
  const client = useQueryClient();
  const customers = useQuery(customersQuery(p.workspaceId));
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<CustomerImport>();
  const importing = useAction(say);
  return (
    <Page embedded title="Customers" description="People who pay you and opted in to hear from you. They get your release emails, never cold email.">
      {p.canEdit && (
        <form
          aria-label="Import Customers"
          className="flex flex-col items-start gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setResult(undefined);
            void importing.run(async () => {
              const r = await importCustomers(p.workspaceId, csv);
              if ("error" in r) return r.error;
              setResult(r);
              setCsv("");
              // New Customers are new People too, so the whole Audience reads again.
              await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
              return null;
            });
          }}
        >
          <p className="max-w-2xl text-sm text-muted-foreground">
            Put the column names in the first row: name, email, company, opted_in, opted_in_on and country. Only rows with opted_in set to yes are added. Write opted_in_on as YYYY-MM-DD and country as a two-letter code, such as US.
          </p>
          <Input
            type="file"
            label="A CSV file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const picked = e.target.files?.[0];
              if (picked) setCsv(await picked.text());
            }}
          />
          <div className="flex w-full flex-col gap-1.5">
            <Textarea label="Or paste the CSV" value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} className="font-mono" />
          </div>
          {importing.error && <Notice tone="error">{importing.error}</Notice>}
          <Button type="submit" pending={importing.pending} disabled={!csv.trim()}>
            Import Customers
          </Button>
        </form>
      )}
      {result && (
        <div role="status" className="flex flex-col gap-2 rounded-card bg-muted px-4 py-3">
          <p className="tabular-nums">
            {`Added ${result.added.length}`} · {`Updated ${result.updated.length}`}
          </p>
          {result.skipped.length > 0 && (
            <ul aria-label="Not added" className="flex flex-col gap-1 text-sm">
              {result.skipped.map((s) => (
                <li key={s.row}>{`Row ${s.row}${s.email ? `, ${s.email}` : ""}. ${sayCustomerSkip(s.reason)}.`}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <QueryBoundary query={customers} skeleton={<Skeleton className="h-32 w-full" />}>
        {({ customers: list }) =>
          list.length === 0 ? (
            <EmptyState title="No Customers yet.">{p.canEdit ? "Import a CSV of them above." : undefined}</EmptyState>
          ) : (
            <div className="overflow-x-auto text-sm">
              <Table aria-label="Customers">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Email</TableHeaderCell>
                    <TableHeaderCell>Company</TableHeaderCell>
                    <TableHeaderCell>Added</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((x) => (
                    <TableRow key={x.personId}>
                      <TableCell className="whitespace-normal">{x.name ?? unknown}</TableCell>
                      <TableCell className="wrap-break-word whitespace-normal">{x.email ?? unknown}</TableCell>
                      <TableCell className="whitespace-normal">{x.company ?? unknown}</TableCell>
                      <TableCell className="tabular-nums">{dayWords(x.addedAt.slice(0, 10))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        }
      </QueryBoundary>
    </Page>
  );
}
