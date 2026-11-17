# Third-party plugins

A third-party plugin is code written outside Direx, against the MIT plugin SDK
(`@trydirex/plugin-sdk`), that connects Direx to another service. A Server admin installs it on a
self-hosted Direx. A Workspace owner then turns it on for their Workspace. ADR 0026 holds the rules.

Direx cloud doesn't take installs yet. There, only plugins Direx has reviewed and ships are
available.

## What a plugin can and can't do

Every third-party plugin runs in its own sandbox, one process per Workspace:

- It sees no files of the server's except its own bundle and system libraries, and no environment
  variables except the few it needs.
- Its only network is a proxy that lets it reach the hosts its manifest lists, on port 443, at
  public addresses. It can't reach the server itself, a private network or any other host.
- It can't make new namespaces, mount anything or trace other processes. `/tmp` holds 64 MB.
- It gets a credential only inside one call, and only the key connected for its own connection.
- Nothing it does reaches the outside world without a person's approval. Its effects are ledger
  Actions like any other, and they always count as reaching a person, whatever the plugin says.

A plugin can still send anything it is handed, such as a key a Workspace connects, to the hosts it
lists. Install only plugins whose hosts you'd trust with that.

In this version a third-party plugin may not:

- send email, read a mailbox, post to social networks, read docs, read Search Console or send
  newsletters (Direx's own plugins do those);
- sign in with OAuth, or connect with anything but one API key;
- read media files, cost money per call, or run triggers.

The installer refuses a plugin that asks for any of these, and says why.

The sandbox needs Linux and bubblewrap, as the Claude Code and Codex sign-ins do. Run Direx with
`deploy/docker/compose.yml`, or install `bwrap` on the host. Where the sandbox can't run, no
third-party plugin starts, and `bun run doctor` says why.

## For Server admins

Install from the Server page, under Plugins, or from the server's shell:

```
bun run plugin install path/to/plugin.js
bun run plugin upgrade path/to/plugin.js
bun run plugin remove com.example.plugin
bun run plugin list
```

Both paths first run the file in the sandbox with no network, to read what it asks for. Then they
show you:

- each thing it can do;
- each connection;
- each host it may reach.

Nothing is installed until you confirm. The web page asks for a sign-in within the last ten
minutes before it uploads, installs or removes.

- **An upgrade** shows what is new and what is gone. If what the plugin may do or reach changes, it
  stops in every Workspace until an owner turns it on again. If only its code changes, it stays on,
  and any Action waiting on it goes back to a person for approval.
- **A removal** stops the plugin in every Workspace at once. A later reinstall needs each owner to
  turn it on again.
- **The stored file** is kept under its SHA-256 in `plugin-store/`, in Direx's data directory. It
  is checked against that hash every time the plugin starts.

## For Workspace owners

Installed plugins are listed on the connections page, under Third-party plugins, with what each
can do and reach. Only an Owner can turn one on or off. Once it is on, connect its key under
Advanced: API keys.

## For plugin authors

Start from `packages/plugin-sdk/examples/hello`. A plugin is one manifest and its handlers, bundled
into one file:

```
bun build plugin.ts --target=bun --outfile dist/plugin.js
```

That `plugin.js`, at most 10 MB, is what a Server admin installs. Some rules for the manifest:

- **`trust`** is `"third_party"`.
- **`id`** is reverse-DNS, and not under `com.trydirex.` or `direx.`.
- **Connections** use `auth: "api_key"` (or `"none"`). A service that needs a login and password
  can take them as one key, such as `login:password`, and build its own header.
- **`egress.hosts`** lists every host the plugin calls, exactly or as `*.example.com`. A wildcard
  over a public suffix, such as `*.co.uk` or `*.workers.dev`, is refused.
- **Effects** are named by the plugin. A person approves the spec `prepare` returns, and `execute`
  runs only that spec.
- **Query names** come from the SDK's catalogue. The ones in it today are shapes only Direx's own
  plugins may offer, so for now a third-party plugin offers effects.

A refused connection reaches your code as a network error, not as an HTTP status, so don't read it
as the service refusing your key. Don't keep files: anything written to `/tmp` is gone when the
process stops, and the process stops when idle.
