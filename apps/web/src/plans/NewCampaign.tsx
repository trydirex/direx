// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { inWorkspace } from "../api/query";
import { Field, Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Input, Textarea } from "@/components/Input";
import { createPlan, REQUEST_MAX, sayCreate, startPlanDraft, strategyQuery, type Strategy } from "./actions";
import { campaignOfPlan } from "../campaigns/actions";

/**
 * Start a campaign, in a dialog on the Campaigns page (ADR 0023). Its plan and Campaign are made together, and it opens
 * on the Campaign's Plan tab, with the drafting run or its refusal. Drafting needs an approved Strategy, on Brand.
 */
export function NewCampaign(p: {
  workspaceId: string;
  initial?: { strategy: Strategy };
  onCancel?: () => void;
  /** The words of an Idea being started, filled in for the person to change. */
  prefill?: { title: string; request: string };
  /** Runs once the plan exists, before the Campaign opens: an Idea links itself to it here. */
  onCreated?: (planId: string) => Promise<void>;
}) {
  const { workspaceId } = p;
  const navigate = useNavigate();
  const client = useQueryClient();
  const strategy = useQuery({ ...strategyQuery(workspaceId), initialData: p.initial?.strategy });
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const approved = strategy.data?.currentVersion != null;

  const open = async (planId: string, search: { run?: string; notice?: string } = {}) => {
    void client.invalidateQueries({ queryKey: inWorkspace(workspaceId, "campaigns") });
    const campaignId = await campaignOfPlan(workspaceId, planId);
    if (!campaignId) return navigate({ to: "/w/$workspaceId/campaigns", params: { workspaceId } });
    return navigate({ to: "/w/$workspaceId/campaigns/$campaignId", params: { workspaceId, campaignId }, search: { tab: "plan", ...search } });
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const asked = (data.get("request") as string).trim();
        const wantsDraft = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "draft";
        if (wantsDraft && !asked) return setError("Say what you want this campaign to do first.");
        setPending(true);
        try {
          const created = await createPlan(workspaceId, { title: data.get("title") as string, ...(asked && { request: asked }) });
          if ("error" in created) return setError(sayCreate(created.error));
          const { id } = created;
          await p.onCreated?.(id);
          if (!wantsDraft) return void (await open(id));
          const r = await startPlanDraft(workspaceId, id);
          await open(id, r.error ? { notice: r.error } : { run: r.runId });
        } finally {
          setPending(false);
        }
      }}
    >
      {error && <Notice tone="error">{error}</Notice>}
      <Field label="Name">
        <Input name="title" required maxLength={200} autoFocus defaultValue={p.prefill?.title} />
      </Field>
      <Field label="What do you want this campaign to do?">
        <Textarea name="request" defaultValue={p.prefill?.request} maxLength={REQUEST_MAX} />
      </Field>
      <div className="flex flex-wrap gap-2">
        {approved && (
          <Button type="submit" value="draft" pending={pending}>
            Draft plan
          </Button>
        )}
        <Button type="submit" variant={approved ? "outline" : "default"} pending={pending}>
          Write it myself
        </Button>
        {p.onCancel && (
          <Button type="button" variant="outline" onClick={p.onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {strategy.data && !approved && (
        <p className="text-sm text-muted-foreground">
          Direx drafts a plan from your Strategy, so approve that first.{" "}
          <Link to="/w/$workspaceId/brand" params={{ workspaceId }}>
            Open Brand
          </Link>
        </p>
      )}
    </form>
  );
}
