// SPDX-License-Identifier: AGPL-3.0-only
import type { components } from "../api/schema";
import { Select } from "@/components/Input";

type MyWorkspace = components["schemas"]["MyWorkspace"];

/**
 * Workspaces grouped by Organization; the last option starts a new Organization. A native select,
 * styled as a control, because it keeps the Organization groups (optgroup) and works the same on
 * every device.
 */
export function WorkspaceSwitcher({ workspaces, current, onSwitch, waiting = {} }: { workspaces: MyWorkspace[]; current: string; onSwitch: (id: string | "new") => void;
  /** What needs the person in each Workspace, so an agency sees which client is waiting before switching. */
  waiting?: Record<string, number> }) {
  const orgs = new Map<string, MyWorkspace[]>();
  for (const w of workspaces) orgs.set(w.organization.id, [...(orgs.get(w.organization.id) ?? []), w]);
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      <Select label="Workspace"
        value={current}
        onChange={(e) => onSwitch(e.target.value)}
        className="min-h-9 w-full rounded-full border border-input bg-background px-4 text-sm font-normal outline-none focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {[...orgs.values()].map((ws) => (
          <optgroup key={ws[0]!.organization.id} label={ws[0]!.organization.name}>
            {ws.map((w) => (
              <option key={w.id} value={w.id}>
                {waiting[w.id] ? `${w.name} · ${waiting[w.id]} need you` : w.name}
              </option>
            ))}
          </optgroup>
        ))}
        <option value="new">New organization or client…</option>
      </Select></div>
  );
}
