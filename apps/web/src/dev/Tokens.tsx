// SPDX-License-Identifier: AGPL-3.0-only
// The design tokens on one page, for checking by eye. Served by the dev server at /tokens.html only;
// `vite build` builds index.html alone, so this never ships.
import { StateChip } from "../items/StateChip";
import { Primitives } from "./Primitives";
import { STATE_LABEL, type ItemState } from "../items/actions";

const COLOURS: [string, string][] = [
  ["background", "bg-background"],
  ["foreground", "bg-foreground"],
  ["muted", "bg-muted"],
  ["muted-foreground", "bg-muted-foreground"],
  ["faint", "bg-faint"],
  ["border", "bg-border"],
  ["input", "bg-input"],
  ["primary", "bg-primary"],
  ["primary-hover", "bg-primary-hover"],
  ["primary-tint", "bg-primary-tint"],
  ["card", "bg-card"],
  ["warning", "bg-warning"],
  ["warning-tint", "bg-warning-tint"],
  ["channel-email", "bg-channel-email"],
  ["channel-post", "bg-channel-post"],
  ["channel-newsletter", "bg-channel-newsletter"],
  ["channel-seo", "bg-channel-seo"],
  ["success", "bg-success"],
  ["success-tint", "bg-success-tint"],
  ["destructive", "bg-destructive"],
  ["destructive-tint", "bg-destructive-tint"],
  ["peach", "bg-peach"],
  ["peach-foreground", "bg-peach-foreground"],
];
const TYPE: [string, string][] = [
  ["xs 12", "text-xs"],
  ["sm 14", "text-sm"],
  ["base 15", "text-base"],
  ["md 17", "text-md"],
  ["lg 22 (section title)", "text-lg font-display"],
  ["xl 30 (page title)", "text-xl font-display"],
];
const RADII: [string, string][] = [
  ["sm 4", "rounded-sm"],
  ["control 12", "rounded-control"],
  ["card 20", "rounded-card"],
  ["full", "rounded-full"],
];

export function Tokens() {
  return (
    <main className="mx-auto flex max-w-content flex-col gap-12 p-8">
      <h1>Tokens</h1>
      <section aria-labelledby="colours" className="flex flex-col gap-4">
        <h2 id="colours">Colours</h2>
        <ul className="grid grid-cols-3 gap-4">
          {COLOURS.map(([name, cls]) => (
            <li key={name} className="flex items-center gap-3">
              <span className={`size-10 rounded-card border border-border ${cls}`} />
              <code className="text-sm">{name}</code>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="type" className="flex flex-col gap-4">
        <h2 id="type">Type</h2>
        {TYPE.map(([name, cls]) => (
          <p key={name} className={cls}>
            {name}: Approve · sends Tue 9:00
          </p>
        ))}
      </section>
      <section aria-labelledby="states" className="flex flex-col gap-4">
        <h2 id="states">States</h2>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(STATE_LABEL) as ItemState[]).map((s) => (
            <StateChip key={s} state={s} />
          ))}
          <StateChip state="held" reason="not sure it sent" />
        </div>
      </section>
      <Primitives />
      <section aria-labelledby="shape" className="flex flex-col gap-4">
        <h2 id="shape">Shape</h2>
        <div className="flex gap-4">
          {RADII.map(([name, cls]) => (
            <div key={name} className={`flex size-24 items-center justify-center border border-border bg-card text-sm ${cls}`}>
              {name}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
