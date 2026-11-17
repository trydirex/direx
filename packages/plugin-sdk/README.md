# @trydirex/plugin-sdk

The contract between [Direx](https://trydirex.com) and its plugins: the manifest a plugin
declares, the handlers it writes, and the worker that answers the host over JSON-RPC on stdin
and stdout. MIT licensed. A plugin that runs in its own process and talks to Direx only through
this SDK is treated by Direx as a separate work, so it can carry its own license.

## Write a plugin

```ts
import { definePlugin, runWorker } from "@trydirex/plugin-sdk";

export const plugin = definePlugin({
  manifest: {
    id: "com.example.hello",
    apiVersion: 1,
    version: "0.1.0",
    minHostVersion: "0.2.0",
    trust: "third_party",
    connections: [{ key: "hello", auth: "api_key" }],
    egress: { hosts: ["api.example.com"] },
    capabilities: [{ kind: "effect", name: "hello.ping", connection: "hello", dedupe: "blind", risk: "low", reachesPerson: false }],
  },
  effects: {
    // execute runs only a spec a person approved; its context's credential holds the key a person
    // pasted, for this call only.
    "hello.ping": {
      prepare: async (input) => ({ spec: input, preview: "Ping Hello" }),
      execute: async () => ({ kind: "sent" }),
    },
  },
});

if (import.meta.main) await runWorker(plugin);
```

The manifest is checked when the plugin loads. A query must be one in Direx's catalogue, and
a third-party plugin that connects to anything lists every host it reaches in `egress.hosts`.
The host refuses anything else. Each catalogue query's input and answer are in the SDK:
`querySchemas(name)` gives the schemas and `QueryInput<N>` and `QueryOutput<N>` the types. The
host parses what Direx sends and what the plugin answers through them, and an answer that does
not fit fails as `provider_error`.

For now Direx treats every effect from a third-party plugin as reaching a Person, whatever its
`reachesPerson` says. An effect whose spec names no Person is held back, so the `hello.ping`
example above installs but never sends.

## When a call fails

An effect's `execute` returns `{ kind: "refused", ... }` when the provider said no. Set `plan` on
it when the account's plan is the reason, such as `plan: "Pro"`.

A query, a poll or a webhook's `normalize` throws a `PluginError` instead:

```ts
throw new PluginError("rate_limited", "Hello answered 429", { status: 429, waitMs: 60_000 });
```

The reason is one of `PLUGIN_REASONS`: `invalid_params`, `not_connected`,
`credential_rejected`, `rate_limited`, `not_found`, `plan_required`, `provider_error` or
`failed`. Direx reads the reason and the fields, never the message, which only goes to its log.
A query listed in `QUERY_CODES` may also set `code` to one of the codes listed for it. Any other
error reaches Direx as `failed`.

A request may carry fields this SDK doesn't know yet. The plugin ignores them, unless the field
limits what it may read. Direx sends such a field only to a plugin built with an SDK that honours
it. Each plugin reports its SDK version when it starts.

## Bundle it

Direx installs one file. Bundle the plugin and its dependencies into it:

```sh
bun build plugin.ts --target=bun --outfile dist/plugin.js
```

[`examples/hello`](https://github.com/trydirex/direx/tree/main/packages/plugin-sdk/examples/hello)
is a complete plugin with that `build` script. Copy it to start your own.

## More

How a Server admin installs a third-party plugin, what the sandbox allows and how upgrades are
approved: [docs/third-party-plugins.md](https://github.com/trydirex/direx/blob/main/docs/third-party-plugins.md).
