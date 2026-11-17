// SPDX-License-Identifier: AGPL-3.0-only
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
] as const;
/** When something happened, as a person reads it: "9 days ago", "yesterday", "just now". */
export function ago(iso: string, now = Date.now()) {
  const seconds = (new Date(iso).getTime() - now) / 1000;
  const unit = UNITS.find(([, size]) => Math.abs(seconds) >= size);
  return unit ? RELATIVE.format(Math.round(seconds / unit[1]), unit[0]) : "just now";
}
