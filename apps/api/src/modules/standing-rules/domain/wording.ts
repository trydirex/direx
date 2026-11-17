// SPDX-License-Identifier: AGPL-3.0-only
// What a person agrees to when they let a rule send email an agent writes. Each rule stores the
// version it was granted under. A change to the words needs a new version and a new signature.
export const AGENT_WRITTEN_WORDING = {
  version: "2026-11-03.1",
  /** Set when the founder signs the words below. Until then the mode can't be granted. */
  signedBy: "Dominik (founder), entered by Claude at the founder's request" as string | null,
  signedOn: "2026-11-03" as string | null,
  statements: [
    "Direx sends these emails without anyone reading them first.",
    "What a recipient's website and their list details say can change what the agent writes.",
    "You are responsible for following the law in every place you send to.",
    "Any member of this workspace can stop this rule at any time.",
  ],
} as const;

export type Wording = { version: string; signedBy: string | null; signedOn: string | null };
export const wordingSigned = (w: Wording) => !!w.signedBy && !!w.signedOn;
