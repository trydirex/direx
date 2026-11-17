# Deployment secrets

Besides each Workspace's credentials, a Direx deployment has a few secrets of its own: the auth
secret, the SMTP URL for sign-in mail, the object storage URL for uploaded files, and on Direx
cloud its provider keys and social network apps. They are kept in the vault, in a system Workspace
with no members, so no route reaches them. [Key custody](security/key-custody.md) explains how the
vault and the root key protect them.

## The secrets command

Run it from the repository root. It needs the root key and the database, the same as the server.

- `bun apps/api/src/secrets.ts list` shows every name, and for each one either "not set" or when
  it last changed. It never shows a value.
- `bun apps/api/src/secrets.ts set <name>` saves the value it reads on stdin, and replaces any
  value already stored. A value is never passed as an argument, so it stays out of your shell
  history and the process list.

```
printf %s "$VALUE" | bun apps/api/src/secrets.ts set smtp.url
```

A third command, `replace-root-key <new key file>`, moves the deployment to a new root key.
[Key custody](security/key-custody.md#replacing-the-root-key) has the steps.

A single trailing newline is dropped. If stdin is empty, nothing changes. An unknown name or any
extra argument prints the usage and the list of names, and changes nothing.

Every read of a value writes an access event.

## What you can set

| Name | Value | When it takes effect |
|---|---|---|
| `auth.secret` | The secret that protects sign-in, at least 32 characters. | At the next start |
| `smtp.url` | The SMTP connection URL for sign-in mail, in the URL form nodemailer accepts. | At the next start |
| `media.s3` | Object storage for uploaded files. See below. | At the next start |
| `signin.google`, `signin.microsoft` | The client secret of the OAuth app people sign in with. Its client id stays in `DIREX_GOOGLE_CLIENT_ID` or `DIREX_MICROSOFT_CLIENT_ID`. | At the next start |
| `provider.anthropic`, `provider.openai`, `provider.google`, `provider.openrouter` | A model provider API key. | On the next model call |
| `social_app.<network>` | A social network's app, as `<client id>:<client secret>`. | The next time it's needed |

The server reads `auth.secret`, `smtp.url`, `media.s3` and the two `signin` secrets once, when it
starts, so restart it after changing any of them.

### Auth secret

Outside development and test, Direx generates the auth secret on first start if none is set. You
only need `set auth.secret` to replace it. A value shorter than 32 characters stops the start.

### SMTP URL

Direx sends sign-in mail, such as password resets, through this server. Outside development and
test, the server refuses to start unless `smtp.url` is set and the `DIREX_MAIL_FROM` environment
variable gives the sender address. In development and test, mail goes to the log instead.

### Provider keys and social apps

Only Direx cloud reads the `provider.*` keys: Anthropic, OpenAI and Google are used there, and
OpenRouter is not. On a self-hosted deployment, each Workspace connects its own model keys or
sign-ins instead.

A `social_app.<network>` value is used when a Workspace hasn't added its own app for that network.
The network name uses lowercase letters, digits, `_` and `-`, up to 40 characters. The client id
can't contain a colon.

### Notion's sign-in

Notion connects two ways. A self-hosted Workspace can type a Notion internal integration's token in
Settings. To let people connect by signing in to Notion instead, as on Direx cloud, register a Notion
public integration and store it as `social_app.notion_oauth`:

1. At https://www.notion.so/profile/integrations, create a new integration of type Public. Choose
   "Any workspace" as its installation scope: Notion sets it only when the integration is made.
2. Add the redirect URI `<base URL>/api/connections/callback`, for example
   `https://direx.example.com/api/connections/callback`.
3. Under Capabilities, tick Read content and Update content, and no user information. Direx needs
   Update content only for status write-back.
4. Fill in the company name, website, privacy policy and terms links Notion asks for.
5. Store the OAuth client ID and client secret:

```
printf %s "$CLIENT_ID:$CLIENT_SECRET" | bun apps/api/src/secrets.ts set social_app.notion_oauth
```

Once it is stored, the Calendar shows "Connect Notion" to anyone not yet connected. Notion's own consent
screen is where the person picks the pages and databases Direx sees. The integration can stay unlisted;
only a listing in Notion's Marketplace is reviewed by Notion.

## Object storage for uploaded files

Without `media.s3`, uploaded files are kept on the server's disk in the `media` folder of the data
directory: `DIREX_DATA_DIR/media`, or `~/.direx/media` by default, next to the root key. If neither
`DIREX_DATA_DIR` nor `HOME` is set, uploads fail.

To keep them in an S3-compatible bucket instead:

1. Create a bucket and an access key that can read, write and delete in it.
2. Build the URL:

   ```
   https://<access key>:<secret>@<host>/<bucket>?region=<region>
   ```

   - `http://` also works.
   - The path is the bucket name and nothing else.
   - Leave out `region` and Direx uses `auto`.
   - Percent-encode any character in the key or secret that isn't allowed in a URL.
3. Save it: `printf %s "$S3_URL" | bun apps/api/src/secrets.ts set media.s3`
4. Restart the server. A value in the wrong form stops the start, and the error shows the expected
   form, never your value.

Direx uploads large files in 8 MiB parts. People open a file through a link that expires after 15
minutes, so the file goes from the bucket straight to the browser. If an upload fails partway, its
parts can stay in the bucket. A lifecycle rule that removes unfinished multipart uploads clears
them.

## Environment variables are no longer read

Outside development and test, the server refuses to start if any of these is set, and names the
command to run instead. Unset the variable and save its value with `set`.

| Variable | Name to set |
|---|---|
| `ANTHROPIC_API_KEY` | `provider.anthropic` |
| `OPENAI_API_KEY` | `provider.openai` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | `provider.google` |
| `OPENROUTER_API_KEY` | `provider.openrouter` |
| `DIREX_AUTH_SECRET` | `auth.secret` |
| `DIREX_SMTP_URL` | `smtp.url` |
| `DIREX_GOOGLE_CLIENT_SECRET` | `signin.google` |
| `DIREX_MICROSOFT_CLIENT_SECRET` | `signin.microsoft` |
