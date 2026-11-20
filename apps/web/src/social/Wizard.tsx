// SPDX-License-Identifier: AGPL-3.0-only
// Setting up a Workspace's own OAuth app: where to make it, the steps, and its client id and secret.
// Social uses it for a network, SEO for Search Console's Google app.
import { useState } from "react";
import { Field } from "../components/layout";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { Secret } from "../credentials/Credentials";
import type { Network } from "./actions";

export type WizardSteps = NonNullable<Network["wizard"]>;

// The network's own rules come from the API; the line sits inside that network's wizard, so it needs no name.
const CALLBACK_PROBLEM: Record<NonNullable<Network["callbackProblem"]>, string> = {
  needs_https: "This network accepts only an https callback URL, and Direx's address here starts with http. Give Direx an https address and set DIREX_BASE_URL to it before you connect.",
  no_localhost: "This network refuses localhost in a callback URL. Open Direx at 127.0.0.1 instead, with DIREX_BASE_URL set to match.",
};

export function Wizard({ label, title, wizard, callbackProblem, save }: { label: string; title?: string; wizard: WizardSteps; callbackProblem?: Network["callbackProblem"]; save: (f: { clientId: string; clientSecret: string }) => Promise<void> }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <details className="w-full max-w-xl text-sm">
      <summary className="cursor-pointer font-medium">{title ?? `Set up ${label}`}</summary>
      <div className="mt-3 flex flex-col gap-3">
        <p>
          Open the{" "}
          <a href={wizard.consoleUrl} className="underline underline-offset-4">
            {wizard.consoleName ?? label} developer console
          </a>
          .
        </p>
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          {wizard.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        {callbackProblem && <p className="font-medium">{CALLBACK_PROBLEM[callbackProblem]}</p>}
        <p>
          Callback URL: <code className="break-all">{wizard.callbackUrl}</code>
        </p>
        <p>
          Permissions to allow: <code>{wizard.scopes.join(" ")}</code>
        </p>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            await save({ clientId, clientSecret }).finally(() => setPending(false));
            setClientSecret("");
          }}
        >
          <Field label="Client ID">
            <Input required autoComplete="off" spellCheck={false} value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </Field>
          <Field label="Client secret">
            <Secret value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
          </Field>
          <div>
            <Button type="submit" size="sm" pending={pending}>
              Save
            </Button>
          </div>
        </form>
      </div>
    </details>
  );
}
