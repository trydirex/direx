// SPDX-License-Identifier: AGPL-3.0-only
// Whose account a sign-in is, as the host parsed its plugin's answer (ADR 0028 rule 001).
import type { QueryOutput } from "@direx/plugin-sdk";

export type SocialIdentity = QueryOutput<"social.identity">;

export const targetsOf = (i: SocialIdentity) => i.targets ?? [{ id: i.accountId, name: i.accountLabel, type: i.accountType ?? "account" }];
