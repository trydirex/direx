// SPDX-License-Identifier: AGPL-3.0-only
// The palette's dialog and search list, on Astryx's CommandPalette. They load the first time the palette
// opens, so the first page stays small.
import { useEffect } from "react";
import { CommandPalette, CommandPaletteInput, useCommandPaletteContext } from "@astryxdesign/core/CommandPalette";
import { kbd, type SearchProps } from "./CommandPalette";
import type { Command } from "./commands";

/** The search field. Astryx clears the highlight on each keystroke; this puts it back on the first
    result once results arrive, so Enter runs the best match as it always has. */
function SearchInput() {
  const c = useCommandPaletteContext();
  useEffect(() => {
    if (c && !c.isBusy && c.highlightedIndex < 0 && c.selectableItems.length > 0) c.setHighlightedIndex(0);
  }, [c]);
  return <CommandPaletteInput label="Search and actions" />;
}

type Entry = { id: string; label: string; auxiliaryData: { group?: string; command: Command } };

export function PaletteSearch({ items, onClose }: SearchProps) {
  const all: Entry[] = items.flatMap((g) => g.items.map((c) => ({ id: c.id, label: c.label, auxiliaryData: { group: g.value || undefined, command: c } })));
  const source = {
    bootstrap: () => all,
    search: (q: string) => all.filter((e) => e.label.toLowerCase().includes(q.trim().toLowerCase())),
  };
  const pick = (id: string) => {
    const c = all.find((e) => e.id === id)?.auxiliaryData.command;
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <CommandPalette
      isOpen
      onOpenChange={(open) => !open && onClose()}
      label="Search and actions"
      input={<SearchInput />}
      searchSource={source}
      onValueChange={pick}
      renderItem={(e: Entry) => (
        <span className="flex w-full items-center justify-between gap-3">
          {e.label}
          {e.auxiliaryData.command.keys && (
            <kbd aria-hidden className={kbd}>
              {e.auxiliaryData.command.keys}
            </kbd>
          )}
        </span>
      )}
    />
  );
}
