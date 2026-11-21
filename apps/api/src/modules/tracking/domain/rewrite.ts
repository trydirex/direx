// SPDX-License-Identifier: AGPL-3.0-only
// Pure: finding the links in a draft's text and putting tracked links in their place (ADR 0035 rules
// 001 and 004). Text is plain or Markdown, so a link is a bare URL or the target of a Markdown link;
// either way it is an https URL, and only those are tracked. An http URL stays as written.

/** The longest destination a tracked link stores; a longer URL stays as written. */
export const MAX_DESTINATION = 2048;

const URL_RUN = /https:\/\/[^\s<>"'`[\]]+/g;
const TRAILING = /[.,;:!?*_~]$/;

// Prose ends a URL with punctuation, and Markdown wraps it in brackets: drop trailing marks, and a
// closing bracket the URL itself never opened, as in `[label](https://a.example/b)`.
function trimmed(run: string): string {
  let url = run;
  for (;;) {
    if (TRAILING.test(url)) url = url.slice(0, -1);
    else if (url.endsWith(")") && url.split("(").length < url.split(")").length) url = url.slice(0, -1);
    else return url;
  }
}

function trackable(url: string): boolean {
  if (url.length > MAX_DESTINATION) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Every https URL in `text` replaced by what `track` gives for it; a URL `track` answers null for, or
 * one that doesn't parse, is left as written. `destinations` lists each trackable URL once, in order.
 */
export function rewriteLinks(text: string, track: (destination: string) => string | null): { text: string; destinations: string[] } {
  const destinations: string[] = [];
  const out = text.replace(URL_RUN, (run) => {
    const url = trimmed(run);
    if (!trackable(url)) return run;
    if (!destinations.includes(url)) destinations.push(url);
    const to = track(url);
    return to === null ? run : to + run.slice(url.length);
  });
  return { text: out, destinations };
}
