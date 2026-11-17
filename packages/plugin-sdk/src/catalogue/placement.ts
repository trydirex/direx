// SPDX-License-Identifier: MIT
// Where an expected Placement check landed, from the provider's labels alone.
import { z } from "zod";
import { skipMail } from "./mail";

export const placementRead = {
  name: "placement.read",
  version: 1,
  input: skipMail,
  output: z.discriminatedUnion("found", [
    z.strictObject({ found: z.literal(false) }),
    z.strictObject({ found: z.literal(true), messageId: z.string().max(998).nullable(), inbox: z.boolean(), spam: z.boolean(), otherTab: z.boolean() }),
  ]),
} as const;
