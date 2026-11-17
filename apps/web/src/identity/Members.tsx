// SPDX-License-Identifier: AGPL-3.0-only
import { Confirm } from "../components/Confirm";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { inWorkspace } from "../api/query";
import { Field, Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { toast } from "@/components/toast";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { invite, invitesQuery, membersQuery, revoke, type Invite, type Member, type Role } from "./actions";
import { message, MESSAGES } from "./messages";
import { SignIn } from "./SignIn";
import { applyChange, savePending, takePending, type Change } from "./step-up";

const ROLES: Role[] = ["owner", "admin", "marketer", "contributor", "viewer"];
const label = (r: string) => r[0]!.toUpperCase() + r.slice(1);
/** What each role may do, read from the API's grants (apps/api/src/modules/identity/domain/roles.ts). */
export const ROLE_DOES: Record<Role, string> = {
  owner: "Everything an Admin can, and can delete the Workspace and undo an opt-out.",
  admin: "Approves, manages members, settings, shared email accounts and keys, and Auto-approve.",
  marketer: "Edits and approves Items, and connects their own email accounts.",
  contributor: "Edits drafts and connects their own email accounts. Can't approve.",
  viewer: "Sees everything. Changes nothing.",
};
const ITEMS = ROLES.map((r) => ({ value: r, label: label(r) }));
/** Only an Owner may give out the Owner role (checkInvite and checkMembershipChange in the API's roles.ts). */
const NOT_OWNER = ITEMS.filter((i) => i.value !== "owner");
/**
 * Below `sm` the members table is too narrow for four columns, so each row becomes a two-column grid.
 * Astryx caps a wrapping cell at max-width 0 to share a table's width; in the grid that would squeeze it to nothing.
 */
const STACK = {
  row: "max-sm:grid max-sm:grid-cols-[1fr_auto] max-sm:items-center max-sm:py-2 max-sm:[&>td]:max-w-none max-sm:[&>td]:border-0 max-sm:border-b max-sm:border-border max-sm:last:border-b-0",
  name: "max-sm:col-start-1 max-sm:row-start-1 max-sm:font-medium",
  end: "max-sm:col-start-2 max-sm:row-start-1",
  wide: "max-sm:col-span-2",
};

function RoleSelect(p: { name: string; value: Role; options: typeof ITEMS; onChange: (r: Role) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <Selector label={p.name} isLabelHidden options={p.options} value={p.value} onChange={(v) => p.onChange(v as Role)} />
      <small className="text-xs text-muted-foreground">{ROLE_DOES[p.value]}</small>
    </div>
  );
}

/** Members and invites of one Workspace. Owners and Admins manage them, except their own row, so no one demotes or removes themselves by accident. */
export function Members({ workspace, me, initial }: { workspace: components["schemas"]["MyWorkspace"]; me?: string; initial?: { members: Member[]; invites?: Invite[] } }) {
  const workspaceId = workspace.id;
  const isOwner = workspace.role === "owner";
  const manage = isOwner || workspace.role === "admin";
  const items = isOwner ? ITEMS : NOT_OWNER;
  const client = useQueryClient();
  const members = useQuery({ ...membersQuery(workspaceId), initialData: initial?.members });
  const invites = useQuery({ ...invitesQuery(workspaceId), initialData: initial?.invites, enabled: manage });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("marketer");
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  /** "invite", or the id of the invite being withdrawn, while that write runs. */
  const [busy, setBusy] = useState<string>();
  /** A promotion to Owner waiting for a yes: it hands over full control, so it asks first. */
  const [promote, setPromote] = useState<{ c: Change; from: Role; who: string }>();
  const [promoting, setPromoting] = useState(false);

  const reload = () => client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
  async function settle(code: string | null) {
    setError(code ? message(code) : undefined);
    await reload();
  }

  /** Runs a change. With `from`, a role change that worked offers Undo, which puts `from` back. */
  async function change(c: Change, from?: Role) {
    const code = await applyChange(c);
    if (code === "step_up_required") {
      savePending(c);
      setStepUp(true);
      return;
    }
    if (!code && c.role && from && from !== c.role)
      toast.add({ title: `Role changed to ${label(c.role)}.`, actionProps: { children: "Undo", onClick: () => void change({ ...c, role: from }) } });
    await settle(code);
  }

  // A change that waited for step-up runs once, here, after the person signs in again.
  useEffect(() => {
    const pending = takePending(workspaceId);
    if (pending) void change(pending);
  }, [workspaceId]);

  if (stepUp) {
    return (
      <SignIn
        title="Confirm it's you"
        note="Changing a role or removing a member needs a recent sign-in. Sign in again and we'll finish the change."
        callbackURL={location.pathname + location.search}
      />
    );
  }

  return (
    <Page title="Members">
      {error && <Notice tone="error">{error}</Notice>}
      <QueryBoundary query={members} messages={MESSAGES} skeleton={<Skeleton className="h-40 w-full" />}>
        {(list) => (
          <div className="overflow-x-auto rounded-card border border-border bg-card px-2">
          {/* On a phone each member stacks: name and Remove, then email, then role (STACK). */}
          <Table className="max-sm:block">
            <TableHeader className="max-sm:sr-only">
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Email</TableHeaderCell>
                <TableHeaderCell>Role</TableHeaderCell>
                {manage && (
                  <TableHeaderCell>
                    <span className="sr-only">Remove</span>
                  </TableHeaderCell>
                )}
              </TableRow>
            </TableHeader>
            <TableBody className="max-sm:block">
              {list.map((m) => {
                const who = m.name || m.email;
                /** Admins can't change or remove an Owner, so an Owner's row is read-only for them. */
                const editable = manage && m.userId !== me && (isOwner || m.role !== "owner");
                return (
                <TableRow key={m.userId} className={STACK.row}>
                  <TableCell className={STACK.name}>{m.name || <span className="text-muted-foreground">No name yet</span>}</TableCell>
                  <TableCell className={`text-muted-foreground ${STACK.wide} break-all`}>{m.email}</TableCell>
                  <TableCell className={STACK.wide}>
                    {editable ? (
                      <RoleSelect
                        name={`Role of ${who}`}
                        value={m.role}
                        options={items}
                        onChange={(r) => {
                          const c = { workspaceId, userId: m.userId, role: r };
                          if (r === "owner" && m.role !== "owner") setPromote({ c, from: m.role, who });
                          else void change(c, m.role);
                        }}
                      />
                    ) : (
                      <>
                        {label(m.role)}
                        <small className="block text-xs text-muted-foreground">{ROLE_DOES[m.role]}</small>
                      </>
                    )}
                  </TableCell>
                  {manage && m.userId === me && (
                    <TableCell className={STACK.end}>
                      <span className="text-sm text-muted-foreground">You</span>
                    </TableCell>
                  )}
                  {manage && m.userId !== me && !editable && <TableCell className={STACK.end} />}
                  {editable && (
                    <TableCell className={STACK.end}>
                      <Confirm
                        title={`Remove ${m.name || m.email}?`}
                        body="They lose access to this Workspace. You can invite them again later."
                        confirm="Remove"
                        onConfirm={() => change({ workspaceId, userId: m.userId, role: null })}
                        trigger={
                          <Button size="sm" variant="outline" aria-label={`Remove ${m.name || m.email}`}>
                            Remove
                          </Button>
                        }
                      />
                    </TableCell>
                  )}
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
          </div>
        )}
      </QueryBoundary>

      {manage && (
        <>
          <Section title="Invite someone">
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                setBusy("invite");
                void invite(workspaceId, email, role)
                  .then((r) => {
                    if ("error" in r) return settle(r.error);
                    toast.add({ title: r.resent ? `${email} already had an invite waiting. We sent it again with a new link.` : `Invite sent to ${email}.` });
                    setEmail("");
                    return settle(null);
                  })
                  .finally(() => setBusy(undefined));
              }}
            >
              <Field label="Email">
                <Input type="email" required autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Selector label="Role" description={ROLE_DOES[role]} options={items} value={role} onChange={(v) => setRole(v as Role)} />
              <Button type="submit" pending={busy === "invite"}>
                Send invite
              </Button>
            </form>
          </Section>
          <QueryBoundary query={invites} messages={MESSAGES} skeleton={<Skeleton className="h-16 w-full" />}>
            {(list) =>
              list.length > 0 && (
                <Section title="Waiting to accept">
                  <ul className="flex flex-col gap-2">
                    {list.map((i) => (
                      <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {i.email} as {label(i.role)}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Withdraw the invite to ${i.email}`}
                          pending={busy === i.id}
                          onClick={() => {
                            setBusy(i.id);
                            void revoke(workspaceId, i.id)
                              .then(settle)
                              .finally(() => setBusy(undefined));
                          }}
                        >
                          Withdraw
                        </Button>
                      </li>
                    ))}
                  </ul>
                </Section>
              )
            }
          </QueryBoundary>
        </>
      )}
      <Dialog isOpen={!!promote} onOpenChange={(o) => !o && setPromote(undefined)} purpose="form" width={384}>
        <DialogHeader title={`Make ${promote?.who ?? ""} an Owner?`} subtitle={`${ROLE_DOES.owner} They get full control of this Workspace.`} />
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={() => setPromote(undefined)}>
            Cancel
          </Button>
          <Button
            pending={promoting}
            onClick={() => {
              if (!promote) return;
              setPromoting(true);
              void change(promote.c, promote.from).finally(() => {
                setPromoting(false);
                setPromote(undefined);
              });
            }}
          >
            Make Owner
          </Button>
        </div>
      </Dialog>
    </Page>
  );
}
