// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RunCaps } from "../agents/Runs";
import { Confirm } from "../components/Confirm";
import { StatusChip } from "../components/StatusChip";
import { inWorkspace } from "../api/query";
import { messageForCode } from "../api/messages";
import type { components } from "../api/schema";
import { Field, Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Input, Select } from "@/components/Input";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { toast } from "@/components/toast";
import { SignIn } from "../identity/SignIn";
import { Adapters } from "./Adapters";
import { addKey, clearKey, cost, dollars, modelsQuery, pickKey, PROVIDER_NAMES, purposeName, saveSettings, testKey, toMicros, type AdapterList, type ModelsData, type ProviderRow } from "./actions";

type S = components["schemas"];

const MESSAGES: Record<string, string> = {
  no_connection: "No key is connected for this provider.",
  credential_unavailable: "That key can't be used any more. Check it under Email and keys.",
  credential_not_usable: "Pick a Workspace API key from Email and keys.",
  configuration: "The provider refused this key. Check that it's correct and has access.",
  provider_quota: "The provider says this key is over its limit. Try again later.",
  transient_upstream: "The provider had a problem. Try again in a minute.",
  no_receipt: "The provider didn't answer in time. Try again.",
  model_refusal: "The provider answered but gave nothing usable. Try again.",
  budget_stop: "This month's model budget is used up.",
  unpriced: "Direx has no price for this provider's model. Allow models with no known price below, then test again.",
  budget_not_allowed: "That budget isn't allowed here. On Direx cloud a budget can only go down.",
  unpriced_not_allowed: "Models with no known price can't be used on Direx cloud.",
  cloud_managed: "Direx manages the keys on Direx cloud.",
  unknown_model: "That model isn't on the list for this AI.",
  no_sign_in: "Sign in first, then test.",
  not_installed: "This AI isn't installed on the machine running Direx.",
  signed_out: "This sign-in has ended. Sign in again.",
  no_link: "The sign-in didn't start. Try again.",
  bad_code: "That code didn't work. Check it and try again.",
  no_token: "The sign-in didn't finish. The code may have expired. Start it again.",
  vault_refused: "Direx couldn't save this sign-in. Try again.",
  file_visible: "This AI could read a file on this machine, so Direx won't use it here.",
};
const message = (code: string) => messageForCode(code, MESSAGES);

type UsageRow = S["ModelUsage"]["rows"][number];
/** Usage by what Direx did, most costly first, naming the models each used. */
export function byPurpose(rows: UsageRow[]) {
  const out = new Map<string, { purpose: string; calls: number; costMicros: number; models: string[] }>();
  for (const r of rows) {
    const g = out.get(r.purpose) ?? { purpose: r.purpose, calls: 0, costMicros: 0, models: [] };
    g.calls += r.calls;
    g.costMicros += Number(r.costMicros);
    if (r.model && !g.models.includes(r.model)) g.models.push(r.model);
    out.set(r.purpose, g);
  }
  return [...out.values()].sort((a, b) => b.costMicros - a.costMicros);
}

/** Which providers a Workspace uses, and what it has spent on them. Nothing here shows a key. */
export function Models(p: { workspace: S["MyWorkspace"]; initial?: ModelsData & { adapters?: AdapterList } }) {
  const { workspace } = p;
  const manage = workspace.role === "owner" || workspace.role === "admin";
  const client = useQueryClient();
  const models = useQuery({ ...modelsQuery(workspace.id, manage), initialData: p.initial });
  // What the person typed; undefined shows the saved budget.
  const [budget, setBudget] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);

  async function settle(code: string | null, done?: string) {
    if (code === "step_up_required") return setStepUp(true);
    setError(code ? message(code) : undefined);
    if (!code && done) toast.add({ title: done });
    if (!code) setBudget(undefined);
    await client.invalidateQueries({ queryKey: inWorkspace(workspace.id) });
  }

  if (stepUp) {
    return (
      <SignIn
        title="Confirm it's you"
        note="Changing how this Workspace uses models needs a recent sign-in. Sign in again, then make the change once more."
        callbackURL={location.pathname + location.search}
      />
    );
  }

  return (
    <Page title="AI models">
      {error && <Notice tone="error">{error}</Notice>}
      <QueryBoundary query={models} skeleton={<Skeleton className="h-96 w-full" />} messages={MESSAGES}>
        {({ deployment, providers, usage, settings, keys }) => {
          const selfHost = deployment === "self_host";
          const shown = budget ?? dollars(settings.monthlyBudgetMicros).slice(1);
          async function saveBudget(e: React.FormEvent) {
            e.preventDefault();
            const micros = toMicros(shown);
            if (!micros) return setError("Enter the budget as a dollar amount, like 50 or 12.50.");
            setSaving(true);
            await saveSettings(workspace.id, { monthlyBudgetMicros: micros, allowUnpriced: settings.allowUnpriced })
              .then((code) => settle(code, "Budget saved."))
              .finally(() => setSaving(false));
          }
          const setUnpriced = async (allowUnpriced: boolean) => settle(await saveSettings(workspace.id, { monthlyBudgetMicros: settings.monthlyBudgetMicros, allowUnpriced }));
          const unpricedLabel = "Allow models with no known price. The budget can't limit what these cost.";
          const providerSection = (
            <Section
              title="Providers"
              description={selfHost ? "Models run on your own keys. Paste a key for a provider below, or pick one already saved under Email and keys." : "Direx provides these models. You don't need a key."}
            >
              <ul className="flex flex-col gap-3">
                {providers.map((row) => (
                  <ProviderItem
                    key={row.provider}
                    row={row}
                    keys={keys}
                    mayChange={manage && selfHost}
                    mayTest={manage}
                    onSet={async (id) => settle(await pickKey(workspace.id, row.provider, id), `${PROVIDER_NAMES[row.provider]} works.`)}
                    onAdd={async (value) => settle(await addKey(workspace.id, row.provider, value), `${PROVIDER_NAMES[row.provider]} works.`)}
                    onClear={async () => settle(await clearKey(workspace.id, row.provider))}
                    onTest={async () => settle(await testKey(workspace.id, row.provider), `${PROVIDER_NAMES[row.provider]} works.`)}
                  />
                ))}
              </ul>
              {selfHost && <p className="text-sm text-muted-foreground">Google uses data from unpaid Gemini API keys for training and human review. Use a paid key.</p>}
              {manage && selfHost && (
                // Not a wrapping label: the confirm dialog must not sit inside one.
                <div className="flex min-h-6 items-center gap-2 text-sm">
                  {settings.allowUnpriced ? (
                    <input id="allow-unpriced" type="checkbox" className="size-4" checked onChange={() => void setUnpriced(false)} />
                  ) : (
                    // Turning it on lifts the budget's limit, so it asks first. Turning it off doesn't.
                    <Confirm
                      title="Allow models with no known price?"
                      body="Direx can't count what these models cost, so this month's budget won't stop them. Watch your provider's bill yourself."
                      confirm="Allow them"
                      onConfirm={() => setUnpriced(true)}
                      trigger={<input id="allow-unpriced" type="checkbox" className="size-4" checked={false} readOnly />}
                    />
                  )}
                  <label htmlFor="allow-unpriced">{unpricedLabel}</label>
                </div>
              )}
            </Section>
          );
          return (
            <>
              <Section title="This month's AI cost">
                <p>
                  {dollars(usage.settledMicros)} of your {dollars(usage.budgetMicros)} budget for {new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${usage.month}-01T00:00:00Z`))}
                  {usage.heldMicros !== "0" && `, with ${dollars(usage.heldMicros)} held for calls in progress`}.
                </p>
                {usage.budgetMicros !== "0" && <ProgressBar label="This month's AI cost against the budget" isLabelHidden value={Math.min(Number(usage.settledMicros), Number(usage.budgetMicros))} max={Number(usage.budgetMicros)} />}
                {usage.incidents.map((i) => (
                  <Notice key={i.threshold}>This month's model cost reached {i.threshold}% of the budget.</Notice>
                ))}
                {usage.rows.length > 0 && (
                  <>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>What Direx did</TableHeaderCell>
                          <TableHeaderCell className="text-right">Cost</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {byPurpose(usage.rows).map((r) => (
                          <TableRow key={r.purpose}>
                            <TableCell className="whitespace-normal">{purposeName(r.purpose)}</TableCell>
                            <TableCell className="text-right tabular-nums">{cost(r.costMicros)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    <details className="text-sm">
                      <summary className="cursor-pointer">Details by model</summary>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHeaderCell>What Direx did</TableHeaderCell>
                            <TableHeaderCell>Model</TableHeaderCell>
                            <TableHeaderCell className="text-right">Calls</TableHeaderCell>
                            <TableHeaderCell className="text-right">Cost</TableHeaderCell>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {usage.rows.map((r) => (
                            <TableRow key={`${r.purpose} ${r.model}`}>
                              <TableCell className="whitespace-normal">{purposeName(r.purpose)}</TableCell>
                              <TableCell>{r.model ?? "No model"}</TableCell>
                              <TableCell className="text-right tabular-nums">{r.calls}</TableCell>
                              <TableCell className="text-right tabular-nums">{cost(r.costMicros)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </details>
                  </>
                )}
                {manage && (
                  <form className="flex flex-wrap items-end gap-3" onSubmit={saveBudget}>
                    <Field label="Monthly budget in dollars" hint={!selfHost && "On Direx cloud a budget can only go down from the default."}>
                      <Input className="max-w-xs" value={shown} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" autoComplete="off" required />
                    </Field>
                    <Button type="submit" variant="outline" pending={saving}>
                      Save budget
                    </Button>
                  </form>
                )}
              </Section>

              {/* Self-hosted, nothing runs until a provider has a key, so Providers sits in the open. On
                  Direx cloud there's nothing to set, so it waits under Advanced. */}
              {selfHost && providerSection}

              {/* A native disclosure: no Astryx component fits a closed "Advanced" block (ADR 0020). */}
              <details className="group rounded-card border border-border bg-card p-6">
                <summary className="cursor-pointer font-medium group-open:mb-6">Advanced</summary>
                <div className="flex flex-col gap-8">
                  {manage && <RunCaps workspaceId={workspace.id} />}

                  {selfHost && <Adapters workspaceId={workspace.id} manage={manage} settle={settle} status={error} initial={p.initial?.adapters} />}

                  {!selfHost && providerSection}
                </div>
              </details>
            </>
          );
        }}
      </QueryBoundary>
    </Page>
  );
}

function ProviderItem(p: {
  row: ProviderRow;
  keys: S["Credential"][];
  mayChange: boolean;
  mayTest: boolean;
  onSet: (id: string) => void;
  onAdd: (value: string) => Promise<unknown>;
  onClear: () => void;
  onTest: () => Promise<unknown>;
}) {
  const { row } = p;
  const [testing, setTesting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [adding, setAdding] = useState(false);
  const name = PROVIDER_NAMES[row.provider];
  return (
    <li className="flex flex-wrap items-center gap-3">
      <span className="font-medium">{PROVIDER_NAMES[row.provider]}</span>
      <StatusChip tone={row.connected ? "good" : "off"}>{row.connected ? "Ready" : "Not set up"}</StatusChip>
      {row.connected && row.credentialName && <span className="text-sm text-muted-foreground">{row.credentialName}</span>}
      {p.mayChange && (
        <Select aria-label={`Key for ${PROVIDER_NAMES[row.provider]}`} value={row.credentialId ?? ""} onChange={(e) => (e.target.value ? p.onSet(e.target.value) : p.onClear())}>
          <option value="">No key</option>
          {p.keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </Select>
      )}
      {p.mayTest && row.connected && (
        <Button size="sm" variant="outline" aria-label={`Test ${PROVIDER_NAMES[row.provider]}`}
          pending={testing}
          onClick={() => {
            setTesting(true);
            void p.onTest().finally(() => setTesting(false));
          }}
        >
          Test
        </Button>
      )}
      {p.mayChange && !row.connected && (
        <form
          className="flex w-full flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setAdding(true);
            void p.onAdd(pasted.trim()).finally(() => {
              setAdding(false);
              setPasted("");
            });
          }}
        >
          <Field label={`Paste your ${name} API key`}>
            <Input className="max-w-xs" type="password" value={pasted} onChange={(e) => setPasted(e.target.value)} autoComplete="off" required />
          </Field>
          <Button type="submit" variant="outline" pending={adding} aria-label={`Save and test ${name} key`}>
            Save and test
          </Button>
        </form>
      )}
    </li>
  );
}
