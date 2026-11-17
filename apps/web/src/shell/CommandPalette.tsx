// SPDX-License-Identifier: AGPL-3.0-only
// Ctrl K (Cmd K on a Mac): go to any screen, or run what the current screen offers, by typing.
// The shortcut has a modifier, so it also works from inside a field.
import { Suspense, useEffect, useRef, useState, type ComponentType } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { Button } from "@/components/Button";
import { RailTip, railButton } from "./RailTip";
import { useRegisteredCommands, type Command } from "./commands";

const destinations = [
  ["Home", "/w/$workspaceId"],
  ["Calendar", "/w/$workspaceId/calendar"],
  ["Campaigns", "/w/$workspaceId/campaigns"],
  ["Audience", "/w/$workspaceId/people"],
  ["Find companies", "/w/$workspaceId/people/find"],
  ["Segments", "/w/$workspaceId/people/cohorts"],
  ["Brand", "/w/$workspaceId/brand"],
  ["Lessons", "/w/$workspaceId/brand/lessons"],
  ["Members", "/w/$workspaceId/settings/members"],
  ["Email and keys", "/w/$workspaceId/settings/credentials"],
  ["Social accounts", "/w/$workspaceId/settings/social"],
  ["AI models", "/w/$workspaceId/settings/models"],
  ["Auto-approve", "/w/$workspaceId/settings/rules"],
] as const;

export const kbd = "rounded-sm border border-current px-1 font-sans text-xs opacity-80";

export type Groups = { value: string; items: Command[] }[];

export type SearchProps = { items: Groups; onClose: () => void };

/** `Search` is the dialog and its list, passed in so the route file can load it only when first opened. */
export function CommandPalette(p: { workspaceId: string; compact?: boolean; Search: ComponentType<SearchProps> & { preload?: () => unknown } }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  // Its code loads on first open, and must have arrived before it renders.
  const show = async () => {
    await p.Search.preload?.();
    setOpen(true);
  };
  // The dialog unmounts as it closes, so focus goes back to the button here, whatever closed it.
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const navigate = useNavigate();
  const screen = useRegisteredCommands();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      if (openRef.current) close();
      else void show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const goTo: Command[] = destinations.map(([label, to]) => ({ id: `go:${to}`, label, group: "Go to", run: () => void navigate({ to, params: { workspaceId: p.workspaceId } }) }));
  const items: Groups = [];
  for (const c of [...screen, ...goTo]) {
    const value = c.group ?? "";
    let group = items.find((g) => g.value === value);
    if (!group) items.push((group = { value, items: [] }));
    group.items.push(c);
  }

  return (
    <>
      {p.compact ? (
        <RailTip label="Search and actions · Ctrl K">
          <button ref={trigger} type="button" data-slot="rail" className={railButton} aria-label="Search and actions" aria-keyshortcuts="Control+K Meta+K" aria-haspopup="dialog" onPointerEnter={() => p.Search.preload?.()} onFocus={() => p.Search.preload?.()} onClick={() => void show()}>
            <SearchIcon className="size-5" aria-hidden />
          </button>
        </RailTip>
      ) : (
        <Button ref={trigger} variant="outline" size="sm" className="justify-between" aria-keyshortcuts="Control+K Meta+K" aria-haspopup="dialog" onPointerEnter={() => p.Search.preload?.()} onFocus={() => p.Search.preload?.()} onClick={() => void show()}>
          Search and actions <kbd aria-hidden className={kbd}>Ctrl K</kbd>
        </Button>
      )}
      {/* The dialog and its search load on first open, so the first page stays small. */}
      {open && (
        <Suspense>
          <p.Search
            items={items}
            onClose={close}
          />
        </Suspense>
      )}
    </>
  );
}
