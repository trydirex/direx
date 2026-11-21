// SPDX-License-Identifier: AGPL-3.0-only
// A Mailbox's pause. Too many bounces or its provider refusing an email as abuse pause it on their own,
// and anyone who edits can pause it by hand.
// Resuming lets what the pause held go, so only someone who approves sees Resume.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { Button } from "@/components/Button";
import { pausesQuery, setPaused } from "./actions";

const WHY = {
  bounces: "Paused because 3 of its latest emails bounced. Nothing goes from it until someone resumes it, so check the addresses it sent to first.",
  provider_abuse: "Paused because its email provider refused an email as spam or abuse. Nothing goes from it until someone resumes it, so check what it sent and to whom first.",
  person: "Paused by hand. Nothing goes from it until someone resumes it.",
} as const;

export function MailboxPause(p: { workspaceId: string; credentialId: string; name: string; mayPause: boolean; mayResume: boolean }) {
  const client = useQueryClient();
  const query = useQuery(pausesQuery(p.workspaceId));
  const pause = query.data?.find((x) => x.credentialId === p.credentialId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const change = async (paused: boolean) => {
    setSaving(true);
    try {
      const failed = await setPaused(p.workspaceId, p.credentialId, paused);
      setError(failed ? "That didn't save. Try again." : undefined);
      if (!failed) await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
    } catch {
      setError("That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  };
  const failed = error && <span role="alert">{error}</span>;
  if (query.isError) return <p role="alert">Couldn't load sending status. <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button></p>;
  if (!query.isSuccess) return <p role="status">Loading sending status…</p>;
  if (!pause) {
    if (!p.mayPause) return null;
    return (
      <p>
        <Button size="sm" variant="outline" aria-label={`Pause sending: ${p.name}`} pending={saving} onClick={() => void change(true)}>
          Pause sending
        </Button>{" "}
        {failed}
      </p>
    );
  }
  return (
    <p role="status">
      {WHY[pause.reason]}
      {p.mayResume && (
        <Button size="sm" variant="outline" className="ml-2" aria-label={`Resume sending: ${p.name}`} pending={saving} onClick={() => void change(false)}>
          Resume
        </Button>
      )}{" "}
      {failed}
    </p>
  );
}
