// SPDX-License-Identifier: AGPL-3.0-only
// The door's readers, registered once (ADR 0032 rules 002 and 003): the only source of its HTTP
// routes, its OpenAPI document and later its MCP tools. Built at start, it stops the start when the
// reads and the catalogue disagree: a name in one and not the other, or a reader whose disclosure
// says personal when the catalogue doesn't, or the other way round.
import type { DoorRead } from "../../core-reads/index";
import { DOOR_READERS, type DoorReader } from "../domain/catalogue";

export type Registration = DoorRead & { name: DoorReader };

export function registerReaders(reads: Readonly<Record<string, DoorRead>>): Registration[] {
  const names = Object.keys(DOOR_READERS) as DoorReader[];
  const missing = names.filter((n) => !Object.hasOwn(reads, n));
  const extra = Object.keys(reads).filter((n) => !(names as string[]).includes(n));
  if (missing.length || extra.length) throw new Error(`door: the readers don't match DOOR_READERS (missing: ${missing.join(", ") || "none"}; not in the catalogue: ${extra.join(", ") || "none"})`);
  const wrong = names.filter((n) => (reads[n]!.disclosure === "personal") !== DOOR_READERS[n].personal);
  if (wrong.length) throw new Error(`door: ${wrong.join(", ")} disagree with DOOR_READERS on whether they are personal`);
  return names.map((name) => ({ ...reads[name]!, name }));
}
