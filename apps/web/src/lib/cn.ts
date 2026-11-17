// SPDX-License-Identifier: AGPL-3.0-only
// Joins class names and lets a later Tailwind class replace an earlier one of the same kind.
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Our radius tokens (styles.css) aren't Tailwind's, so without this `rounded-card` would not replace a component's `rounded-full`.
const twMerge = extendTailwindMerge({ extend: { theme: { radius: ["card", "control"] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
