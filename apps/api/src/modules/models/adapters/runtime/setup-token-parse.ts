// SPDX-License-Identifier: AGPL-3.0-only
// Reads the sign-in link and the token from `claude setup-token`'s terminal output. Written from
// Paperclip's setup-token-parse.ts (MIT, Copyright (c) 2025 Paperclip AI, github.com/paperclipai/paperclip;
// its notice is in THIRD_PARTY_NOTICES.md). It accepts only the exact shapes the CLI prints, and
// never logs or throws with what it read.

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const STOP = `[^${ESC}${BEL}]*`;
const OSC_END = `(?:${ESC}\\\\|${BEL})`;
const HYPERLINK = new RegExp(`${ESC}\\]8;[^;${ESC}${BEL}]*;(${STOP})${OSC_END}[\\s\\S]*?${ESC}\\]8;[^;${ESC}${BEL}]*;${OSC_END}`, "g");
const ANY_OSC = new RegExp(`${ESC}\\]${STOP}${OSC_END}`, "g");
const HORIZONTAL_MOVE = new RegExp(`${ESC}\\[[0-9;]*[GC]`, "g");
const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");

const AUTH_URLS = ["https://claude.ai/oauth/authorize", "https://claude.com/cai/oauth/authorize"];
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const REQUIRED = ["client_id", "code", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"];
const API_KEY = /sk-ant-/i;
const MAX_URL = 2048;
const MAX_ADDED_KEYS = 4;
const MAX_URL_LINES = 16;
const MAX_PREAMBLE_GAP = 512;
const SHAPES: Record<string, (v: string) => boolean> = {
  client_id: (v) => /^[A-Za-z0-9._~-]{1,128}$/.test(v),
  code: (v) => /^[A-Za-z0-9._~-]{1,1024}$/.test(v),
  code_challenge: (v) => /^[A-Za-z0-9_-]{43,128}$/.test(v),
  code_challenge_method: (v) => v === "S256",
  redirect_uri: (v) => v === REDIRECT_URI,
  response_type: (v) => v === "code",
  scope: (v) => v.length <= 512 && v.split(" ").length <= 8 && v.split(" ").every((t) => /^[A-Za-z0-9:._-]{1,64}$/.test(t)),
  state: (v) => /^[A-Za-z0-9_-]{16,256}$/.test(v),
};

const BEFORE_TOKEN = "Your OAuth token (valid for 1 year):";
const AFTER_TOKEN = "Store this token securely. You won't be able to see it again.";

export const plain = (text: string) =>
  text.replace(HYPERLINK, "$1").replace(ANY_OSC, "").replace(HORIZONTAL_MOVE, " ").replace(CSI, "");

function validUrl(candidate: string): string | null {
  if (candidate.length > MAX_URL || API_KEY.test(candidate)) return null;
  if (!candidate.startsWith("https://claude.ai/") && !candidate.startsWith("https://claude.com/")) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port || url.hash) return null;
  if (!AUTH_URLS.includes(`${url.origin}${url.pathname}`)) return null;
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return null;
  if ([...url.searchParams].some(([k, v]) => API_KEY.test(k) || API_KEY.test(v))) return null;
  if (!REQUIRED.every((k) => url.searchParams.has(k) && SHAPES[k]!(url.searchParams.get(k)!))) return null;
  const added = keys.filter((k) => !REQUIRED.includes(k));
  if (added.length > MAX_ADDED_KEYS) return null;
  return added.every((k) => /^[a-z][a-z0-9_-]{0,63}$/.test(k) && /^[\x20-\x7E]{0,256}$/.test(url.searchParams.get(k)!)) ? candidate : null;
}

/** The sign-in link, once the screen has both it and the prompt for the browser's code. */
export function parseSignInLink(text: string): string | null {
  const clean = plain(text);
  const preamble = /the url below to sign in/i.exec(clean);
  if (!preamble) return null;
  const lines = clean.slice(preamble.index + preamble[0].length).split(/\r\n|\r|\n/);
  let offset = 0;
  for (let i = 0; i < lines.length && offset <= MAX_PREAMBLE_GAP; offset += lines[i]!.length + 1, i++) {
    if (!/^https:\/\/claude\.(ai|com)\//.test(lines[i]!.trim())) continue;
    let joined = "";
    for (let j = i; j < Math.min(lines.length, i + MAX_URL_LINES); j++) {
      const piece = lines[j]!.trim();
      if (!piece || !/^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(piece)) break;
      joined += piece;
      const url = validUrl(joined);
      if (!url) continue;
      const next = lines.slice(j + 1).map((l) => l.trim()).find((l) => l && l.replace(/[)\].,;:!]+$/, "") !== url);
      if (next && /^Paste code here if prompted\b[\s>*]*$/.test(next)) return url;
    }
  }
  return null;
}

/** The CLI turned the code down, so waiting for a token would only waste the person's time. */
export const parseSignInRejected = (text: string): boolean => /OAuth error/i.test(plain(text));

/** The token, only from between the two lines of the success screen, each there exactly once. */
export function parseSignInToken(text: string): string | null {
  const lines = plain(text).split(/\r\n|\r|\n/).map((l) => l.trim());
  const before = lines.indexOf(BEFORE_TOKEN);
  const after = lines.indexOf(AFTER_TOKEN);
  if (before < 0 || after <= before || lines.lastIndexOf(BEFORE_TOKEN) !== before || lines.lastIndexOf(AFTER_TOKEN) !== after) return null;
  const pieces = lines.slice(before + 1, after).filter(Boolean);
  if (pieces.length === 0 || !pieces.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null;
  const token = pieces.join("");
  return /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(token) ? token : null;
}
