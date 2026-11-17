// SPDX-License-Identifier: AGPL-3.0-only
// Kept apart from Shell so the route file can use these without loading the whole shell up front.
import type { ReactNode } from "react";

/** Links between the screens inside one nav item, such as Brand and Lessons. */
export function SectionNav(p: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={p.label} className="mb-6 flex flex-wrap gap-5 border-b border-border">
      {p.children}
    </nav>
  );
}
export const sectionLink = "-mb-px flex min-h-9 items-center border-b-2 border-transparent text-sm text-muted-foreground no-underline hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground";
