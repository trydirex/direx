// SPDX-License-Identifier: AGPL-3.0-only
// The few layout pieces every screen is built from, so pages share one rhythm.
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * A screen: its title, one line on what it is for, its main actions, then its content. `embedded`
 * when one screen shows inside another (a Campaign's Plan tab): a section with a second-level title,
 * so the page keeps one main landmark and one top heading.
 */
export function Page(p: { title: ReactNode; description?: ReactNode; actions?: ReactNode; embedded?: boolean; children: ReactNode }) {
  const Tag = p.embedded ? "section" : "main";
  const Title = p.embedded ? "h2" : "h1";
  return (
    <Tag data-page className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-2xl flex-col gap-2">
          <Title>{p.title}</Title>
          {p.description && <p className="text-muted-foreground">{p.description}</p>}
        </div>
        {p.actions && <div className="flex flex-wrap gap-2">{p.actions}</div>}
      </header>
      {p.children}
    </Tag>
  );
}

/** A block of a screen: an outlined card with a heading. */
export function Section(p: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={p.title} className="flex flex-col gap-4 rounded-card border border-border bg-card p-6">
      <div className="flex flex-col gap-1">
        <h2>{p.title}</h2>
        {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}
      </div>
      {p.children}
    </section>
  );
}

/** A labelled form control. Put the Input, Textarea or Select inside. An Input or Textarea is an Astryx
    field that draws its own label and hint, so Field hands them over; anything else gets this label. */
export function Field(p: { label: string; hint?: ReactNode; children: ReactNode }) {
  if (isValidElement(p.children) && (p.children.type as { astryxField?: boolean }).astryxField)
    return <div className="flex flex-col gap-1.5">{cloneElement(p.children as ReactElement<{ label?: string; hint?: ReactNode }>, { label: p.label, hint: p.hint })}</div>;
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium">
      {p.label}
      {p.children}
      {p.hint && <span className="font-normal text-muted-foreground">{p.hint}</span>}
    </label>
  );
}

/** A screen or list with nothing in it yet: what will be here, one line on how it fills, and the one thing to do next. */
export function EmptyState(p: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className="flex flex-col items-start gap-3 rounded-card border border-dashed border-input bg-card p-6">
      <p className="font-medium">{p.title}</p>
      {p.children && <p className="text-muted-foreground">{p.children}</p>}
      {p.action}
    </div>
  );
}

/** A result or refusal after an action: an alert for what went wrong, a status otherwise. */
export function Notice(p: { tone?: "error" | "info"; children: ReactNode }) {
  return p.tone === "error" ? (
    <p role="alert" className="rounded-card bg-destructive-tint px-4 py-3 text-destructive">
      {p.children}
    </p>
  ) : (
    <p role="status" className="rounded-card bg-muted px-4 py-3">
      {p.children}
    </p>
  );
}
