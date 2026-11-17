# Connecting an agent or a script

A script, a connector or your own AI agent can read a Workspace through the door, with an External
token. It can't approve, send, schedule or change settings. ADR 0032 holds the rules.

Not yet in the app: the tokens page in Settings and the door's routes are built but not mounted, so
nothing below works on a running Direx until they are.

## Make a token

In Settings, under External tokens, an Owner or Admin who signed in within the last 10 minutes picks
a name, how long it lasts (7, 30 or 90 days; a self-hosted Direx can allow up to a year with
`DIREX_EXTERNAL_TOKEN_MAX_DAYS`) and what it may read. It starts with `dxt_` and shows once. Any
Member can revoke it. It stops working while the person who made it isn't an Owner or Admin.

The reads:

| Read | What it gives | Shows People's details |
|---|---|---|
| `read_changes` | Item state changes since a cursor, oldest first | No |
| `read_campaign` | The Campaigns, or one Campaign's goal, dates, steps and counts | No |
| `read_needs_you` | What waits for a person, with titles | Yes, in titles |
| `read_schedule` | What is planned between two dates, with titles | Yes, in titles |

## Over HTTP

Each read is a `POST` with the token in `Authorization`:

```
curl -X POST https://direx.example.com/api/door/v1/w/<workspace id>/read_changes \
  -H "Authorization: Bearer dxt_..." -H "Content-Type: application/json" -d '{}'
```

With no cursor, `read_changes` answers with no changes and a cursor for now. Send that cursor back
each time; a change can arrive late, never twice or not at all. The full contract, versioned, is at
`/api/door/v1/openapi.json`.

A token gets 60 requests a minute, and a Workspace 300. Over that, the answer is 429 with
`Retry-After` in seconds.

## As MCP tools

The same reads are MCP tools at `/api/door/v1/w/<workspace id>/mcp` (Streamable HTTP, no
sessions). Each tool is one read the token chose.

- **Claude Code:**
  `claude mcp add --transport http direx https://direx.example.com/api/door/v1/w/<workspace id>/mcp --header "Authorization: Bearer dxt_..."`
- **Claude (claude.ai):** add a custom connector with the same URL and the header. On Team and
  Enterprise plans, everyone who uses the connector shares that one token.
- **Codex and other MCP clients:** add a Streamable HTTP server with the URL and the
  `Authorization` header, as the client's MCP settings describe.
- **ChatGPT:** not yet. It signs in only by OAuth, which the door doesn't offer yet.
