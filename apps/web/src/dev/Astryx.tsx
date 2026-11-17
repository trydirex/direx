// SPDX-License-Identifier: AGPL-3.0-only
// The ADR 0020 spike (plan A1): four Astryx components under the Mailroom theme, on the token page
// only. Nothing in the app imports this.
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { CommandPalette } from "@astryxdesign/core/CommandPalette";

const PLACES = ["Home", "Calendar", "Campaigns", "Audience", "Brand", "Settings"].map((label) => ({ id: label.toLowerCase(), label }));
const places = {
  search: (q: string) => PLACES.filter((p) => p.label.toLowerCase().includes(q.toLowerCase())),
  bootstrap: () => PLACES,
};

export function AstryxSpike() {
  const [dialog, setDialog] = useState(false);
  const [palette, setPalette] = useState(false);
  const [picked, setPicked] = useState("nothing yet");
  return (
    <section aria-labelledby="astryx" className="mx-auto flex max-w-content flex-col gap-4 p-8">
      <h2 id="astryx">Astryx</h2>
      <p className="text-muted-foreground">Last picked: {picked}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button label="Approve and send" variant="primary" onClick={() => setPicked("Approve")} />
        <Button label="Edit" variant="secondary" onClick={() => setPicked("Edit")} />
        <Button label="Pause all sending" variant="destructive" onClick={() => setPicked("Pause")} />
        <Button label="Open dialog" variant="secondary" onClick={() => setDialog(true)} />
        <DropdownMenu
          button={{ label: "Workspace", variant: "secondary" }}
          hasChevron
          items={[
            { id: "acme", label: "Acme", onClick: () => setPicked("Acme") },
            { id: "globex", label: "Globex", onClick: () => setPicked("Globex") },
            { type: "divider" },
            { id: "out", label: "Sign out", variant: "destructive", onClick: () => setPicked("Sign out") },
          ]}
        />
        <Button label="Search (Ctrl K)" variant="ghost" onClick={() => setPalette(true)} />
      </div>
      <Dialog isOpen={dialog} onOpenChange={setDialog} purpose="form" width={384}>
        <DialogHeader title="Skip this email?" subtitle="It stays in the Campaign as Skipped." onOpenChange={setDialog} />
        <div className="flex justify-end gap-2 pt-4">
          <Button label="Cancel" variant="secondary" onClick={() => setDialog(false)} />
          <Button label="Skip" variant="primary" onClick={() => { setPicked("Skip"); setDialog(false); }} />
        </div>
      </Dialog>
      <CommandPalette
        isOpen={palette}
        onOpenChange={setPalette}
        label="Go to"
        searchSource={places}
        renderItem={(p) => p.label}
        onValueChange={(v) => { setPicked(v); setPalette(false); }}
      />
    </section>
  );
}
