// SPDX-License-Identifier: AGPL-3.0-only
// A step's setup on the Content tab, a manual step's link, and the launch every step keeps its distance from.
import { useState } from "react";
import { Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Input, Select } from "@/components/Input";
import { useAction } from "../components/useAction";
import {
  dayWords,
  followStep,
  moveLaunch,
  recordOutput,
  say,
  type AnchorMove,
  type Loaded,
  type Step,
  type StepSetup,
} from "./actions";

export type Box = { id: string; name: string };
export type DraftingMode = "template" | "per_person";
/**
 * A native select drawn like the ui controls; it keeps its options in the page for every reader.
 * Capped at its container, since a native select grows to its longest option and on a phone runs past the card.
 */
const label = "flex max-w-full min-w-0 flex-col gap-1.5 text-sm font-medium";

/** What kind of step it is, in words: "email", "LinkedIn DM you send yourself". */
export const kindWords = (s: Pick<Step, "type" | "dmChannel">) =>
  s.type === "email"
    ? "email"
    : s.type === "post"
      ? "social post"
      : s.type === "clips"
        ? "video clips from a recording"
        : s.type === "seo_brief"
          ? "SEO brief"
          : s.type === "dm"
            ? `${s.dmChannel === "x" ? "X" : "LinkedIn"} DM you send yourself`
            : "manual step";

export function StepRow(p: {
  step: Step;
  steps: Step[];
  boxes: Box[];
  edit: boolean;
  /** `mode` is the email's "Written as", offered only where `withMode` is set (the Step settings drawer). */
  onSave: (s: StepSetup, mode?: DraftingMode) => Promise<void>;
  /** In the Step settings drawer the form shows at once; elsewhere it stays folded under the line. */
  unfolded?: boolean;
  withMode?: boolean;
}) {
  const { step: s } = p;
  const saving = useAction();
  const [mode, setMode] = useState<DraftingMode>(s.draftingMode ?? "template");
  const [setup, setSetup] = useState<StepSetup>({
    type: s.type as StepSetup["type"],
    touchClass: s.touchClass as StepSetup["touchClass"],
    mailboxCredentialId: s.mailboxCredentialId,
    audience: s.audience as StepSetup["audience"],
    dmChannel: s.dmChannel as StepSetup["dmChannel"],
    dependsOnStepKey: s.dependsOnStepKey,
    utm: s.utm,
  });
  const name = s.title ?? s.key;
  // Only a manual step or a social post has a link another step can wait for.
  const linkable = p.steps.filter(
    (o) =>
      o.inPlan &&
      o.key !== s.key &&
      (o.type === "manual" || o.type === "post" || o.type === "seo_brief"),
  );
  const titleOf = (key: string) =>
    p.steps.find((o) => o.key === key)?.title ?? key;
  if (!s.inPlan)
    return (
      <p className="text-muted-foreground">{name}: no longer in the plan.</p>
    );
  const kind = kindWords(s);
  const summary = (
    <>
      <span className="font-medium">
        {s.on && `${dayWords(s.on)} `}
        {name}
      </span>
      <span className="text-muted-foreground">
        {" · "}
        {kind}
        {s.dependsOnStepKey && `, goes out after ${titleOf(s.dependsOnStepKey)} goes live`}
      </span>
    </>
  );
  if (!p.edit) return <p>{summary}</p>;
  const form = (
        <form
          className="flex flex-wrap items-end gap-3 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void saving.run(async () => {
              await p.onSave(setup, p.withMode && setup.type === "email" ? mode : undefined);
              return null;
            });
          }}
        >
          <div className={label}>
            <Select label="Type"
              value={setup.type}
              onChange={(e) => {
                const type = e.target.value as StepSetup["type"];
                // A post is not a Touch, so it has no kind of email. A DM is cold, sent by hand, from no Mailbox.
                if (type === "dm")
                  return setSetup({
                    ...setup,
                    type,
                    touchClass: "cold",
                    mailboxCredentialId: null,
                    dmChannel: setup.dmChannel ?? "linkedin",
                  });
                setSetup({
                  ...setup,
                  type,
                  touchClass:
                    type === "post" || type === "clips" || type === "seo_brief"
                      ? null
                      : (setup.touchClass ?? "cold"),
                  dmChannel: null,
                });
              }}
            >
              <option value="manual">
                Manual: a person marks it done on the Plan tab
              </option>
              <option value="email">Email</option>
              <option value="post">Social post</option>
              <option value="clips">Video clips from a recording</option>
              <option value="seo_brief">SEO brief for one page</option>
              <option value="dm">DM you send yourself</option>
            </Select></div>{" "}
          {setup.type === "dm" && (
            <div className={label}>
              <Select label="On"
                value={setup.dmChannel ?? "linkedin"}
                onChange={(e) =>
                  setSetup({
                    ...setup,
                    dmChannel: e.target.value as "linkedin" | "x",
                  })
                }
              >
                <option value="linkedin">LinkedIn</option>
                <option value="x">X</option>
              </Select></div>
          )}
          {setup.type === "email" && (
            <>
              <div className={label}>
                <Select label="Email account"
                  value={setup.mailboxCredentialId ?? ""}
                  onChange={(e) =>
                    setSetup({
                      ...setup,
                      mailboxCredentialId: e.target.value || null,
                    })
                  }
                >
                  <option value="">Choose one</option>
                  {p.boxes.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select></div>
              {p.boxes.length === 0 && (
                <small className="text-sm text-muted-foreground">
                  No email account is connected yet. Connect one under Email and keys.
                </small>
              )}
              <div className={label}>
                <Select label="Goes to"
                  value={setup.audience}
                  onChange={(e) =>
                    setSetup({
                      ...setup,
                      audience: e.target.value as StepSetup["audience"],
                    })
                  }
                >
                  <option value="everyone">Everyone in the campaign</option>
                  <option value="no_reply_yet">
                    People who haven't replied yet
                  </option>
                </Select></div>
              <div className={label}>
                <Select label="Who can receive this"
                  value={setup.touchClass ?? "cold"}
                  onChange={(e) =>
                    setSetup({
                      ...setup,
                      touchClass: e.target.value as StepSetup["touchClass"],
                    })
                  }
                >
                  <option value="cold">People who haven't opted in</option>
                  <option value="consented_marketing">
                    Subscribers who opted in
                  </option>
                </Select></div>
            </>
          )}
          {p.withMode && setup.type === "email" && !s.cancelled && (
            <div className={label}>
              <Select label="Written as" value={mode} onChange={(e) => setMode(e.target.value as DraftingMode)}>
                <option value="template">Same email for everyone, names filled in (fast, no AI cost per person)</option>
                <option value="per_person">Personalised for each person from their website (uses AI)</option>
              </Select>
            </div>
          )}
          <div className={label}>
            <Select label="Goes out after"
              value={setup.dependsOnStepKey ?? ""}
              onChange={(e) =>
                setSetup({ ...setup, dependsOnStepKey: e.target.value || null })
              }
            >
              <option value="">No other step</option>
              {linkable.map((o) => (
                <option key={o.key} value={o.key}>
                  {`${o.title ?? o.key} goes live`}
                </option>
              ))}
            </Select></div>
          {/* An SEO brief reads the page itself, so tags on its link would only change the page it reads. */}
          {setup.dependsOnStepKey && setup.type !== "seo_brief" && (
            <label className="flex min-h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={setup.utm ?? false}
                onChange={(e) => setSetup({ ...setup, utm: e.target.checked })}
              />{" "}
              Add tracking tags (UTM) to the link
            </label>
          )}
          <Button
            type="submit"
            size="sm"
            variant="outline"
            pending={saving.pending}
          >
            Save step
          </Button>
        </form>
  );
  if (p.unfolded) return form;
  // Setup is changed rarely and the writing below it daily, so the form stays folded under the step's line.
  return (
    <div className="flex flex-col gap-2">
      <p>{summary}</p>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          Change setup
        </summary>
        {form}
      </details>
    </div>
  );
}

/** A manual step's link, such as the launch page, which steps that wait for it put in their text. */
export function ManualLink(p: {
  workspaceId: string;
  id: string;
  step: Step;
  edit: boolean;
  label?: string;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState(p.step.output?.url ?? "");
  const [error, setError] = useState<string>();
  const saving = useAction();
  const current = p.step.output;
  return (
    <div className="flex flex-col gap-3">
      {current ? (
        <p>
          Link: <a href={current.url}>{current.url}</a>{" "}
          {`(version ${current.version})`}
        </p>
      ) : (
        <p className="text-muted-foreground">No link yet.</p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {p.edit && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            await saving.run(async () => {
              const failed = await recordOutput(
                p.workspaceId,
                p.id,
                p.step.key,
                url,
              );
              setError(failed ? say(failed) : undefined);
              if (!failed) p.onSaved();
              return null;
            });
          }}
        >
          <div className={`${label} min-w-64 flex-1`}>
            <Input
              label={p.label ?? `Link for ${p.step.title ?? p.step.key}`}
              type="url"
              value={url}
              required
              maxLength={2048}
              placeholder="https://"
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            pending={saving.pending}
          >
            Save link
          </Button>
          {current && (
            <small className="w-full text-sm text-muted-foreground">
              {" "}
              Changing it holds approved emails that used the old link until
              they're approved again.
            </small>
          )}
        </form>
      )}
    </div>
  );
}

/** The launch every step keeps its distance from: move it, with a preview first, or let a manual step's link set it. */
export function LaunchLine(p: {
  workspaceId: string;
  id: string;
  campaign: Loaded;
  edit: boolean;
  onChange: () => void;
}) {
  const { anchor, steps } = p.campaign;
  const [on, setOn] = useState(anchor.on ?? "");
  const [preview, setPreview] = useState<AnchorMove>();
  const [error, setError] = useState<string>();
  const previewing = useAction();
  const moving = useAction();
  // A manual step's link, or a post step's post on the account it names, can set the launch.
  const manual = steps.filter(
    (s) =>
      s.inPlan &&
      !s.cancelled &&
      (s.type === "manual" ||
        (s.type === "post" && s.outputConnection !== null)),
  );
  const follows = anchor.stepKey
    ? (steps.find((s) => s.key === anchor.stepKey)?.title ?? anchor.stepKey)
    : null;
  const done = async (failed: string | null) => {
    setError(failed ? say(failed) : undefined);
    setPreview(undefined);
    if (!failed) p.onChange();
  };
  return (
    <section aria-label="Launch" className="flex flex-col gap-4">
      <p className="font-medium">
        {anchor.on ? <>Launch: {dayWords(anchor.on)}</> : p.edit ? "Pick a launch date" : "Launch: no date yet"}
        {anchor.on && follows && `, or when "${follows}" goes live, if that's later`}
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {p.edit && (
        <>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              await previewing.run(async () => {
                const r = await moveLaunch(p.workspaceId, p.id, on, true);
                setError("error" in r ? say(r.error) : undefined);
                if (!("error" in r)) setPreview(r);
                return null;
              });
            }}
          >
            <div className={label}>
              <Input label="Move the launch to"
                type="date"
                className="w-auto"
                value={on}
                required
                onChange={(e) => setOn(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              pending={previewing.pending}
            >
              Preview
            </Button>
          </form>
          {preview && (
            <div
              role="status"
              className="flex flex-col items-start gap-3 rounded-card bg-muted px-4 py-3"
            >
              <p>
                {preview.moved === 0
                  ? "Nothing is drafted yet, so only the steps' dates change."
                  : `${preview.moved} not yet sent ${preview.moved === 1 ? "moves" : "move"} to follow it.`}
                {preview.kept > 0 &&
                  ` ${preview.kept} approved ${preview.kept === 1 ? "goes" : "go"} later as approved, and Home says so.`}
                {preview.backToApproval > 0 &&
                  ` ${preview.backToApproval} approved ${preview.backToApproval === 1 ? "needs" : "need"} approving again, because ${preview.backToApproval === 1 ? "it goes" : "they go"} earlier.`}
              </p>
              <Button
                type="button"
                size="sm"
                pending={moving.pending}
                onClick={() =>
                  void moving.run(async () => {
                    const r = await moveLaunch(p.workspaceId, p.id, on, false);
                    await done("error" in r ? r.error : null);
                    return null;
                  })
                }
              >
                Move the launch
              </Button>
            </div>
          )}
          {manual.length > 0 && (
            <div className={label}>
              <Select label="Launch when"
                value={anchor.stepKey ?? ""}
                onChange={async (e) =>
                  done(
                    await followStep(
                      p.workspaceId,
                      p.id,
                      e.target.value || null,
                    ),
                  )
                }
              >
                <option value="">the date above</option>
                {manual.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.title ?? s.key} goes live
                  </option>
                ))}
              </Select></div>
          )}
        </>
      )}
    </section>
  );
}
