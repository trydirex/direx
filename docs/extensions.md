# Extensions

An extension is an interface in core that a separately installed package can fill. Direx Cloud
uses them to add what only a hosted deployment needs, such as a key held in a KMS. Core calls only
the interface and never names the package. With nothing installed, each extension refuses or does
nothing, so a self-hosted server runs exactly as it does without them.

Extensions are not [third-party plugins](third-party-plugins.md). A plugin connects a Workspace to
another service and runs in a sandbox. An extension runs inside the server process, with the
server's access, and only the operator of a deployment installs one.

## Supplying extensions

A package supplies extensions by starting Direx itself, in place of `bun run start`, through
`startServer` in `apps/api/src/main.ts`:

```ts
await startServer({ discovery, admission, rootKey, oauthApps });
```

Each field is optional, except `admission` on a cloud deployment. `runServer` takes the same
fields, for a package that serves HTTP itself. The types are in
`apps/api/src/modules/extensions/index.ts`, except `Admission`, which is in `modules/identity`.

## The extensions

| Field | What it supplies | With nothing installed |
|---|---|---|
| `discovery` | Finds companies for search terms, with a cost estimate first. | Every search refuses with `not_available`. A pasted list still works. |
| `admission` | Who may sign up and create an Organization. | The self-host sign-up rules (ADR 0024). A cloud start without one refuses. |
| `rootKey` | The deployment's root key, so a KMS can hold it. | `DIREX_MASTER_KEY`, the key file, or a generated one. See [key custody](security/key-custody.md). |
| `oauthApps` | OAuth apps per connection, ahead of the server's own. | None. Connections use the Workspace's app, then the server's. |

## `oauthApps`

```ts
type OAuthApps = {
  apps(ctx: { workspaceId: string; orgId: string; connection: string }): Promise<{ clientId: string; clientSecret: string }[]>;
};
```

A connection that runs on an OAuth app takes the first app it finds: the Workspace's own, then the
first app `oauthApps` returns, then the server's `social_app.<connection>` app, then, for Gmail and
Search Console only, the sign-in app. [Which app a connection uses](deployment-secrets.md#which-app-a-connection-uses)
has the details.

- **Context.** `orgId` lets a package decide per Organization, for example offering an app only on
  some plans. Core knows nothing about plans.
- **Order.** Return apps newest first. A new connect uses the first.
- **Transactions.** Core calls `apps` with no database transaction open, so a slow call (a secrets
  manager, a network lookup) holds no connection.
- **Rotation.** Each grant records the app that issued it, and a refresh or revoke uses that app. To
  rotate, return the new app first and keep the old one after it until its grants are gone. A grant
  whose app is no longer returned needs reconnecting, with the access event `app_gone`.

## Versions

`EXTENSIONS_VERSION` goes up on any change to a type in `modules/extensions`. A package built
against another version should refuse to start, since a shape it doesn't know may be called
differently.
