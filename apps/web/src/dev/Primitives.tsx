// SPDX-License-Identifier: AGPL-3.0-only
// The restyled shadcn/ui primitives, for checking by eye on the dev token page.
import { useState } from "react";
import { Button } from "@/components/Button";
import { Confirm } from "@/components/Confirm";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Input } from "@/components/Input";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Toaster, toast } from "@/components/toast";

const VIEWS = [
  { label: "Week", value: "week" },
  { label: "Month", value: "month" },
];

const STEPS = [
  ["plan", "Plan", "The Plan step and its Measures."],
  ["drafts", "Drafts", "Drafts waiting for you."],
  ["people", "People", "Who this Campaign reaches."],
  ["results", "Results", "What happened."],
] as const;

export function Primitives() {
  const [view, setView] = useState("week");
  const [step, setStep] = useState("plan");
  return (
    <section aria-labelledby="primitives" className="flex flex-col gap-6">
      <h2 id="primitives">Components</h2>
      <div className="flex flex-wrap items-center gap-3">
        <Button>Approve · sends Tue 9:00</Button>
        <Button variant="outline">Edit</Button>
        <Button variant="secondary">Skip</Button>
        <Button variant="ghost">Why</Button>
        <Button variant="destructive">Pause all sending</Button>
        <Button size="sm" variant="outline">
          Review 12
        </Button>
        <Button disabled>Disabled</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input label="Subject" className="w-72" defaultValue="Q4 ops: a quick question" />
        <Selector label="Calendar view" isLabelHidden options={VIEWS} value={view} onChange={setView} width={160} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Confirm trigger={<Button>Approve all with no warnings</Button>} title="Approve 12 with no warnings?" body="Anything with a warning is left for you." confirm="Approve 12" onConfirm={() => undefined} />
        <DropdownMenu
          button={{ label: "Contoso", variant: "secondary" }}
          items={[{ type: "section", title: "Workspaces", items: [{ id: "contoso", label: "Contoso" }, { id: "direx", label: "Direx" }] }, { type: "divider" }, { id: "new", label: "New organization" }]}
        />
        <Button variant="outline" onClick={() => toast.add({ title: "Approved", description: "Sends Tue 9:00" })}>
          Show a toast
        </Button>
      </div>
      <TabList role="tablist" value={step} onChange={setStep}>
        {STEPS.map(([v, label]) => (
          <Tab key={v} value={v} label={label} panelId={`step-${v}`} />
        ))}
      </TabList>
      {STEPS.map(([v, label, text]) => (
        <div key={v} role="tabpanel" id={`step-${v}`} aria-label={label} hidden={step !== v}>
          {text}
        </div>
      ))}
      <div className="flex flex-col gap-2" aria-hidden>
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-6 w-96" />
      </div>
      <Toaster />
    </section>
  );
}
