// SPDX-License-Identifier: AGPL-3.0-only
// The rail's icon-only buttons (Workspace, Search, Ask) and their labels. The label is an Astryx Tooltip beside the icon, on hover and on
// keyboard focus; the control carries the same words as its accessible name.
import type { ReactElement } from "react";
import { Tooltip } from "@astryxdesign/core/Tooltip";

export const railButton = "group relative flex size-10 items-center justify-center rounded-control text-muted-foreground no-underline hover:bg-accent hover:text-foreground aria-[current=page]:bg-primary-tint aria-[current=page]:text-primary";

export function RailTip(p: { label: string; children: ReactElement }) {
  return (
    <Tooltip content={p.label} placement="end">
      {p.children}
    </Tooltip>
  );
}
