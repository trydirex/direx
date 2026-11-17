// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { Field, Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Textarea } from "@/components/Input";
import { toast } from "@/components/toast";
import { useAction } from "../components/useAction";
import { ChannelMark, channelOf } from "../components/ChannelMark";
import { copyDm, listDms, makeDms, markDmSent, momentWords, saveDmText, say, type Dm, type DmResult, type Step } from "./actions";

const NETWORK: Record<string, string> = { linkedin: "LinkedIn", x: "X" };
const WHY: Record<string, string> = { no_profile: "no profile saved for this network", replied: "replied", removed: "removed", conflict: "in another campaign", not_eligible: "can't be contacted", missing_merge_field: "missing a merge field" };
const why = (r: DmResult) => WHY[r.reason ?? r.leftOut?.reason ?? ""] ?? "left out";

/**
 * A DM step. Direx writes one message per Person; you copy it, send it yourself on LinkedIn or X, and
 * mark it sent. Direx never sends a DM, so nothing here waits for approval.
 */
export function DmStep(p: { workspaceId: string; id: string; step: Step; edit: boolean; initial?: Dm[] }) {
  const { workspaceId, id, step } = p;
  const network = NETWORK[step.dmChannel ?? ""] ?? "the network";
  const [dms, setDms] = useState(p.initial ?? []);
  const [left, setLeft] = useState<DmResult[]>([]);
  const [error, setError] = useState<string>();
  const saving = useAction();
  const making = useAction();
  /** A refusal stays on the step; what worked says so once. */
  const tell = (failed: string | undefined, done: string) => {
    setError(failed);
    if (!failed) toast.add({ title: done });
  };
  const load = async () => setDms(await listDms(workspaceId, id, step.key));
  useEffect(() => void load(), [workspaceId, id, step.key]);

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = String(new FormData(e.currentTarget).get("text"));
    await saving.run(async () => {
      const r = await saveDmText(workspaceId, id, step.key, { revision: step.templateRevision, text });
      tell("error" in r ? say(r.error) : undefined, "error" in r || !r.warnings.length ? "Saved." : `Saved. To check: ${r.warnings.join(" ")}`);
      return null;
    });
  };
  const make = () =>
    making.run(async () => {
      const r = await makeDms(workspaceId, id, step.key);
      setError("error" in r ? say(r.error) : undefined);
      if ("error" in r) return null;
      setLeft(r.results.filter((x) => !x.ok));
      await load();
      return null;
    });
  const copy = async (dm: Dm, text: string) => {
    // Both start inside the click: a popup blocker refuses a window opened after an await.
    const copied = navigator.clipboard.writeText(text);
    window.open(dm.profileUrl, "_blank", "noopener");
    await copied;
    const r = await copyDm(workspaceId, dm.id);
    tell("error" in r ? say(r.error) : undefined, "error" in r || !r.direxTouchNear ? "Copied. Send it, then mark it sent." : "Copied. Direx emailed them, or will, within 3 days, so this may land close to it.");
  };
  const sent = async (dm: Dm) => {
    const failed = await markDmSent(workspaceId, dm.id);
    tell(failed ? say(failed) : undefined, "Marked sent. Direx's next cold email to them waits 3 days.");
    await load();
  };

  return (
    <section className="flex flex-col gap-4">
      <p className="text-muted-foreground">{`You send each of these yourself on ${network}. Direx drafts them and never sends one.`}</p>
      {error && <Notice tone="error">{error}</Notice>}
      {dms.map((dm) => (
        <DmCard key={dm.id} dm={dm} edit={p.edit} onCopy={copy} onSent={sent} />
      ))}
      {p.edit && (
        <form onSubmit={save} className="flex flex-col gap-3">
          <Field label="Message">
            <Textarea name="text" rows={4} defaultValue={step.template?.text ?? ""} required />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="outline" pending={saving.pending}>
              Save message
            </Button>
            <Button type="button" size="sm" variant={dms.length ? "outline" : "default"} pending={making.pending} onClick={() => void make()}>
              Make DMs
            </Button>
          </div>
        </form>
      )}
      {left.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {left.map((x) => (
            <li key={x.personId}>{`${x.email ?? x.personId}: ${why(x)}`}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DmCard(p: { dm: Dm; edit: boolean; onCopy: (dm: Dm, text: string) => Promise<void>; onSent: (dm: Dm) => Promise<void> }) {
  const { dm } = p;
  const [text, setText] = useState(dm.text);
  const copying = useAction();
  const marking = useAction();
  return (
    <article className="flex flex-col gap-2 rounded-card border border-border p-4">
      <p className="flex flex-wrap items-center gap-2">
        <ChannelMark channel={channelOf(dm.channel)} />
        <a href={dm.profileUrl} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate">
          {dm.profileUrl}
        </a>
        {dm.sentAt && <small className="text-sm text-muted-foreground">{`Sent ${momentWords(dm.sentAt)}`}</small>}
      </p>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} readOnly={!p.edit || dm.sentAt !== null} aria-label="DM text" />
      {p.edit && !dm.sentAt && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" pending={copying.pending} onClick={() => void copying.run(async () => {
                await p.onCopy(dm, text);
                return null;
              })}>
            Copy and open profile
          </Button>
          <Button type="button" size="sm" variant="outline" pending={marking.pending} onClick={() => void marking.run(async () => {
                await p.onSent(dm);
                return null;
              })}>
            Mark sent
          </Button>
        </div>
      )}
    </article>
  );
}
