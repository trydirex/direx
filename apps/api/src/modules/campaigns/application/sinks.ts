// SPDX-License-Identifier: AGPL-3.0-only
// The sink agents hand a campaign's `draft` proposals to. A reader's quotes start a writer, a writer's
// email is checked and goes to its Person, a template run fills its step's template, and a post's rewrite revises that post. Each by its output key.
import type { Items } from "../../items";
import { sinkByOutputKey, type Sink } from "../../agents";
import { RECIPIENT_READ_KEY, RECIPIENT_WRITE_KEY, TEMPLATE_OUTPUT_KEY } from "../definitions/drafter";
import type { Outreach } from "../../outreach";
import type { Generate } from "./draft-checks";
import { templateSink, type FactReads, type OnTemplateSaved, type PostPort, type StartDraft } from "./drafting";
import { readerSink, writerSink } from "./person-drafts";

export function campaignSinks({ facts, now, outreach, startDraft, generate, onTemplateSaved, items, posts }: { facts: FactReads; now?: () => Date; outreach?: (() => Outreach) | undefined; startDraft?: (() => StartDraft) | undefined; generate?: (() => Generate) | undefined; onTemplateSaved?: OnTemplateSaved | undefined; items?: (() => Items) | undefined; posts?: (() => PostPort) | undefined }): { draft: Sink; byKey: Record<string, Sink> } {
  const clock = now ?? (() => new Date());
  const byKey: Record<string, Sink> = {
    [RECIPIENT_READ_KEY]: (workspaceId, proposal, context) => readerSink(workspaceId, proposal, context, { startDraft }),
    [RECIPIENT_WRITE_KEY]: (workspaceId, proposal, context) => writerSink(workspaceId, proposal, context, { facts, now: clock, outreach, generate, items }),
    [TEMPLATE_OUTPUT_KEY]: (workspaceId, proposal, context) => templateSink(workspaceId, proposal, context, { facts, now: clock, onTemplateSaved, posts }),
  };
  return { draft: sinkByOutputKey(byKey), byKey };
}
