// SPDX-License-Identifier: AGPL-3.0-only
// Read a docs tool's page (Notion first) for brand facts: pick one of the pages shared with Direx, and
// the brand reader reads its words as it reads pasted text. Its proposals arrive like any other read's.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Field, Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Select } from "../components/Input";
import { docsPages, readDocsPage } from "./actions";

type Page = { id: string; title: string };
const SAY: Record<string, string> = {
  not_connected: "Connect it in Settings first.",
  needs_reconnecting: "Its key no longer works. Replace it in Settings.",
  no_access: "Direx can't see that page. Share it with Direx's integration in Notion, then try again.",
  busy: "It's busy right now. Try again in a minute.",
  empty_page: "That page has no text to read.",
  disabled: "Reading is switched off for this Workspace.",
};
const say = (code: string) => SAY[code] ?? "That didn't work. Try again.";

export function DocsPicker(p: { workspaceId: string; provider: string; onStarted: (cut: boolean) => void; onCancel: () => void }) {
  const [pages, setPages] = useState<Page[]>();
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void docsPages(p.workspaceId).then((r) => {
      if ("error" in r) return setError(say(r.error));
      setPages(r.pages);
      setChosen(r.pages[0]?.id ?? "");
    });
  }, [p.workspaceId]);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        try {
          const r = await readDocsPage(p.workspaceId, chosen);
          if ("error" in r) setError(say(r.error));
          else p.onStarted(r.cut);
        } finally {
          setPending(false);
        }
      }}
    >
      {error && (
        <Notice tone="error">
          {error}{" "}
          {error === SAY.not_connected || error === SAY.needs_reconnecting ? (
            <Link to="/w/$workspaceId/settings/credentials" params={{ workspaceId: p.workspaceId }}>
              Open Settings
            </Link>
          ) : null}
        </Notice>
      )}
      {pages && pages.length === 0 && <p className="text-sm text-muted-foreground">No pages are shared with Direx yet. In {p.provider}, open a page's ••• menu and add Direx's integration under Connections.</p>}
      <div className="flex flex-wrap items-end gap-3">
        {pages && pages.length > 0 && (
          <div className="min-w-64 flex-1">
            <Field label={`${p.provider} page`}>
              <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
                {pages.map((pg) => (
                  <option key={pg.id} value={pg.id}>
                    {pg.title}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <Button type="submit" pending={pending} disabled={!chosen}>
          Read
        </Button>
        <Button type="button" variant="outline" onClick={p.onCancel}>
          Use an address instead
        </Button>
      </div>
    </form>
  );
}
