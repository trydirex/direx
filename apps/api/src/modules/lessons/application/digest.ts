// SPDX-License-Identifier: AGPL-3.0-only
// The digest that names the set of lessons a run carried.
import { createHash } from "node:crypto";

export type CarriedLesson = { lessonId: string; version: number; text: string };

export const lessonDigest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Names the set regardless of order; "" for none, which matches a drafter recorded before lessons. */
export function setDigest(set: readonly CarriedLesson[]): string {
  if (!set.length) return "";
  const keys = set.map((l) => `${l.lessonId}@${l.version}:${lessonDigest(l.text)}`).sort();
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}
