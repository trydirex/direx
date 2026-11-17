// SPDX-License-Identifier: AGPL-3.0-only
// Joining the Placement circle from a Mailbox that said yes to Placement checks. The signer emailed
// join code part 1 to the Mailbox and gave its person part 2; this sends the reply to that email.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { useAction } from "@/components/useAction";
import { joinCircle, placementQuery, type JoinCodes } from "./actions";

const REFUSED: Record<string, string> = {
  not_granted: "This email account has no live yes to Placement checks, so it can't join.",
  not_granter: "Only whoever said yes to Placement checks for this email account can send its join reply.",
  provider_cannot_join: "This email account's provider can't join the Placement circle yet.",
};
const EMPTY: JoinCodes = { part1: "", part2: "", signer: "", messageId: "" };

/** Shown only to the person whose yes placement runs under; on the cloud there is nothing to show. */
export function PlacementJoin(p: { workspaceId: string; credentialId: string; name: string; me: string }) {
  const q = useQuery(placementQuery(p.workspaceId, p.credentialId));
  const [codes, setCodes] = useState<JoinCodes>();
  const [sent, setSent] = useState(false);
  const join = useAction(REFUSED);
  if (q.data?.status !== "on" || q.data.grant?.answeredBy !== p.me) return null;
  if (sent) return <p>The join reply is on its way. The signer adds this email account once it arrives.</p>;
  if (!codes)
    return (
      <Button size="sm" variant="outline" aria-label={`Join the Placement circle: ${p.name}`} onClick={() => setCodes(EMPTY)}>
        Join the Placement circle
      </Button>
    );
  const field = (key: keyof JoinCodes) => ({ required: true, value: codes[key], onChange: (e: { target: { value: string } }) => setCodes({ ...codes, [key]: e.target.value }) });
  return (
    <form
      className="flex flex-col gap-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void join.run(async () => {
          const failed = await joinCircle(p.workspaceId, p.credentialId, codes);
          if (!failed) setSent(true);
          return failed;
        });
      }}
    >
      <p className="text-muted-foreground">
        The signer emailed join code part 1 to this Mailbox and gave you part 2. In Gmail, open that email, choose "Show original" from its menu, and copy its Message ID.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Input label="Part 1, from the email" className="w-64" autoComplete="off" {...field("part1")} />
        <Input label="Part 2, from the signer" className="w-64" autoComplete="off" {...field("part2")} />
        <Input label="The email's Message ID" className="w-80" autoComplete="off" {...field("messageId")} />
        <Input label="The address it came from" type="email" className="w-64" {...field("signer")} />
      </div>
      <div className="flex gap-3">
        <Button type="submit" size="sm" pending={join.pending}>
          Send the join reply
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setCodes(undefined)}>
          Cancel
        </Button>
      </div>
      {join.error && <p role="alert">{join.error}</p>}
    </form>
  );
}
