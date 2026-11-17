// SPDX-License-Identifier: AGPL-3.0-only
// What the current screen can do, for the command palette: a screen registers its commands while it
// is mounted, and they leave with it.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type Command = { id: string; label: string; keys?: string; run: () => void; group?: string };

type Registry = { commands: Command[]; register: (list: Command[]) => () => void };
const CommandsContext = createContext<Registry | null>(null);

export function CommandsProvider(p: { children: ReactNode }) {
  const [sets, setSets] = useState<Command[][]>([]);
  const register = useCallback((list: Command[]) => {
    setSets((s) => [...s, list]);
    return () => setSets((s) => s.filter((x) => x !== list));
  }, []);
  const value = useMemo(() => ({ commands: sets.flat(), register }), [sets, register]);
  return <CommandsContext.Provider value={value}>{p.children}</CommandsContext.Provider>;
}

/** The commands every mounted screen registered. */
export function useRegisteredCommands() {
  return useContext(CommandsContext)?.commands ?? [];
}

/** Registers `commands` while the calling screen is mounted. Each `run` is the latest one passed. */
export function useCommands(commands: Command[]) {
  const register = useContext(CommandsContext)?.register;
  const latest = useRef(commands);
  useLayoutEffect(() => {
    latest.current = commands;
  });
  const shape = JSON.stringify(commands.map((c) => [c.id, c.label, c.keys, c.group]));
  useEffect(() => {
    if (!register) return;
    // Re-registers only when what the palette shows changes, not on every render.
    return register(latest.current.map((c) => ({ ...c, run: () => latest.current.find((l) => l.id === c.id)?.run() })));
  }, [register, shape]);
}
