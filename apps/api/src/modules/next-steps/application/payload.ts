// SPDX-License-Identifier: AGPL-3.0-only
// A Next step's payload as stored on its Item, checked whenever it is read back.
import { z } from "zod";
import type { NextStep } from "../domain/chain";

export const NextStepPayload: z.ZodType<NextStep> = z.discriminatedUnion("link", [
  z.strictObject({ link: z.literal("plan_to_templates"), campaignId: z.uuid(), planId: z.uuid(), planVersion: z.number().int().positive(), stepKeys: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ link: z.literal("template_to_drafts"), campaignId: z.uuid(), stepKey: z.string().min(1), templateRevision: z.number().int().positive() }),
  z.strictObject({ link: z.literal("due_to_drafts"), campaignId: z.uuid(), stepKey: z.string().min(1) }),
]);
