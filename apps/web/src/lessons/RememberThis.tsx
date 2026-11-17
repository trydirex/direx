// SPDX-License-Identifier: AGPL-3.0-only
// After a person saves an edit, one sentence about how this Workspace likes the work done. It waits in
// Needs you until someone who may turn on Auto-approve accepts it; only then does the writer use it.
import { useState } from "react";
import { Field } from "../components/layout";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { proposeLesson, sayLesson, writerWords, type Writer } from "./actions";

export function RememberThis(p: { workspaceId: string; agent: Writer; sourceRef: string }) {
  const [text, setText] = useState("");
  const [said, setSaid] = useState<string>();
  const [pending, setPending] = useState(false);
  return (
    <details>
      <summary className="cursor-pointer py-1 text-sm text-muted-foreground">Remember this?</summary>
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          const r = await proposeLesson(p.workspaceId, p.agent, text, p.sourceRef).finally(() => setPending(false));
          setSaid(r ? sayLesson(r.error, r.reasons) : `Waiting in Needs you. Once accepted, ${writerWords(p.agent)} keeps it in mind here.`);
          if (!r) setText("");
        }}
      >
        <div className="w-full max-w-xl">
          <Field label="In one sentence, how do you like this done?">
            <Input value={text} maxLength={300} required onChange={(e) => setText(e.target.value)} placeholder="First emails here run under 90 words." />
          </Field>
        </div>
        <Button type="submit" size="sm" variant="outline" pending={pending}>
          Suggest it
        </Button>
      </form>
      {said && (
        <p role="status" className="mt-2 text-sm">
          {said}
        </p>
      )}
    </details>
  );
}
