# Operator holds: stopping a Workspace, an Organization or the whole server

Whoever runs a Direx server can stop sending for one Workspace, one Organization (all of its
Workspaces) or the whole deployment. No member can lift an operator hold, unlike pausing a
Workspace or a Mailbox. Use one for a tenant sending what it shouldn't, for one client of an agency,
or to stop everything at once, for example when a provider warns about your OAuth app.

A hold holds, it doesn't block: nothing is lost. Every Action that falls due while it is live is held
as **operator_hold**, before Direx fetches a key or calls a plugin, and the Workspace sees "whoever
runs this Direx stopped sending" on each one. Your reason stays with you; the Workspace sees only
the scope. Lifting the hold puts what it held back to scheduled within a minute, and each one goes
through every check again, so mail that went stale meanwhile (an opt-out, a reply, a late time)
is still caught.

## Setting and lifting a hold

On the server, from the repository root, where `.env` is:

```
bun run server-admin hold --org <organization-id> --reason "spam reports from recipients"
bun run server-admin hold --workspace <workspace-id> --reason "..."
bun run server-admin hold --deployment --reason "Google warned about the OAuth app"
bun run server-admin holds
bun run server-admin lift --org <organization-id>
```

The command connects as the database owner (`DIREX_DB_OWNER_URL`), the only role that may set or
lift a hold, and records your login name as who did it. Setting a hold that is already live changes
nothing. `holds` lists the live ones with their reasons. `system.operator_holds` keeps every hold
and lift, with who and when; rows are never deleted.

## How fast it stops

The Dispatcher reads the hold under each Action's row lock, at the claim and again just before the
provider call. No Action whose dispatch check starts after the hold commits can send. An email
already past that check when you commit it may still go: at most one per running dispatch, a few
per worker.

While a hold is live, the Workspace's model calls are refused as `operator_hold` too, so it drafts
nothing and spends nothing. An agent run stops at its next model call, and no prospecting run
starts, so no search or verification vendor is paid.

## What it doesn't stop

- Reading replies, bounces and opt-outs keeps running, so they are still recorded, and so does the
  model call that reads a reply for an opt-out.
- Asking a provider whether an earlier send went out keeps running. That never sends.
- An email that may already have gone out (an unknown outcome being sent again) is held as
  unknown, not as operator_hold, and waits for a person after the lift.
