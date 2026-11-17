# Key custody for stored credentials

Direx stores credentials for each Workspace: connected Mailboxes, API keys, logins and
other values that plugins and model calls need. This page says where the key that
protects them lives, what can read a value, what gets recorded, and what a backup does and
does not restore.

## How values are encrypted

There are two layers of keys.

- **The root key.** One per deployment. It never touches the database.
- **A data key per Workspace.** Random, 32 bytes, created when the Workspace stores its
  first credential. The database keeps it only in wrapped form, encrypted by the root
  key, together with the id of the root key that wrapped it.

Each value is encrypted with AES-256-GCM under its Workspace's data key. The ciphertext
is bound to its row: the Workspace id, the credential id and the data key version go in
as associated data. A ciphertext copied into another row or another Workspace fails to
decrypt instead of producing someone else's value.

No value is hashed or fingerprinted, and none is stored unencrypted. Beside the
ciphertext, the database keeps plain metadata such as the name, kind and status, a header
name or username, and for a Mailbox its email address and the permissions Google granted.

## Where the root key lives

| Mode | Root key |
|---|---|
| Self-hosted | A file Direx generates on first start: `DIREX_DATA_DIR/master.key`, by default `~/.direx/master.key`, readable only by its owner. To supply your own, set `DIREX_MASTER_KEY` (32 bytes as 64 hex characters or base64) or `DIREX_MASTER_KEY_FILE`, which take priority. The API refuses a key file that is readable by group or others. |
| Local development | The same generated file. |
| Direx Cloud | A key held in a cloud key management service. The cloud build supplies it through the same interface and never generates one. It is not part of this repository. |

The root key can't be stored in the vault, because it is what decrypts the vault, and it
can't be stored in the database, because then a dump would expose every credential.

**Back up the key file separately from the database.** If it is lost, no stored credential
can be read again, and they have to be entered or connected again.

The first start records the root key's id in the database, never the key. After that, a
process with a different key, or with no key at all, refuses to start and generates nothing,
so a lost file or a container without a persistent disk stops the server instead of quietly
making every credential unreadable. The API and the worker must share one key: on separate
hosts, put the same file on both or set `DIREX_MASTER_KEY` on both. `bun run doctor` also
lists any Workspace whose keys were set up under another root key, since this deployment
can't read its credentials or approvals.

Two keys are derived from the root key, and nothing else is: the key that wraps each
data key, and the key that seals the OAuth state cookie. That cookie carries the PKCE
verifier between the start of a Google consent and its callback.

## Approval keys

Each Workspace has its own key for signing approvals, so a leak in one Workspace can't forge
approvals in another. It is generated at the Workspace's first use, sealed under the
Workspace's data key and kept in its own table. No credential route, plugin or agent can
reach it: only the ledger receives it, to sign an approval and to check one before sending.
Creating one writes an entry to the Workspace's audit log.

If a Workspace's approval keys can't be loaded, a due Action is held, not sent, with the reason
"this Workspace's approval keys can't be read". A passing fault is retried. Keys sealed under
another root key wait for a person, because only restoring that key can open them.

## Who and what can decrypt

Only a running API or worker process that holds the root key can turn a ciphertext back
into a value, and only at these points:

- **A plugin call.** When the ledger sends an approved Action, reconciles one, answers a
  query or polls a trigger, the plugin receives the one credential that call names. A
  Mailbox gives the plugin an access token, never the refresh token.
- **A model call or an MCP server call.** The model module asks for a provider key or a
  sign-in, uses it for one call and drops it. The MCP client is not built yet. A dependency
  check in `bun run ci` stops any other module from asking.

Agents never receive a value, by any route. No API response contains one: after saving,
a person sees the name, kind and status, never the value again. That includes the person
who saved it.

People with database access, including the application's own database role, see
ciphertext only. Unwrapped data keys stay in process memory for 5 minutes and are never
written anywhere.

A personal credential stops working the moment its owner leaves the Workspace. It does not
fall back to anyone else's value.

## What is recorded

Every time a value is used, or a credential is created, replaced, connected, disconnected
or deleted, Direx writes one access event: which credential, what used it (for example a
send, a poll or a rotation), the outcome, an error code if it failed, the Action it served
if any, the person who did it if any, and the time. An access event never contains a
value. The application's database role can add access events but cannot change or delete
them.

Deleting a credential keeps its row and its history; only the ciphertext is erased.
When an Owner or Admin deletes someone else's credential, the Workspace audit log records
that too.

If a plugin repeats a credential's value in an error or a refusal, Direx replaces the
value with `[redacted]` before the ledger writes anything down.

A credential's owner can read its access history, and so can Owners and Admins.

## Backups

A database backup restores no credential on its own. Without the root key, the wrapped
data keys cannot be opened, so every value in the backup is unreadable.

Keep the root key backed up separately from the database, somewhere the database backup
cannot reach. If the root key is lost, nothing can recover the values: every Mailbox has
to be connected again and every other credential entered again.

## Replacing the root key

Replace the root key if a copy of it may have leaked, or on whatever schedule you keep.

1. Stop the API and the worker.
2. With the current key still in place, run:

   ```
   bun apps/api/src/secrets.ts replace-root-key /path/to/new.key
   ```

   If the file isn't there, Direx generates a key into it, readable only by its owner. To
   supply your own key, put it in the file first.
3. Start the API and the worker with the new file: put it where the old key file was, or set
   `DIREX_MASTER_KEY_FILE`.
4. Back the new file up apart from the database, then destroy every copy of the old key.

The command wraps each Workspace's data key under the new root key and then records the new
key's id. No credential is encrypted again, so it is quick. If it stops partway, run it again
with the same two keys and it finishes. It refuses when the key in the environment isn't the
one the deployment runs with, and when some Workspace's data key is under a third root key;
`bun run doctor` lists those Workspaces.

A server left running with the old key keeps working for up to 5 minutes, then holds its due
Actions until it is restarted with the new key. A Google or network consent that was open
during the change has to be started again.

Replacing the root key shuts out someone who has the old key file. It does not help against
someone who also had a copy of the database from before the change: they can still read
everything in that copy, so replace those credentials at their providers.

## The deployment's own secrets

Direx's provider keys on cloud, each social network's app on cloud, the auth secret, the SMTP
URL, the Google and Microsoft sign-in client secrets and the object storage URL for uploaded
files (`media.s3`) are stored in the vault too,
in a system Workspace with no members, so no route reaches them. Set them with
`bun apps/api/src/secrets.ts set <name>`, which reads the value from stdin. `list` shows names
and when each last changed, never a value. The auth secret is generated on first start. Each
read writes an access event. Direx reads the auth secret, the SMTP URL, the sign-in client
secrets and `media.s3` once at startup, so changing any of them needs a restart; provider keys
apply on the next call.

Losing the root key therefore also loses the SMTP URL and the auth secret: everyone is signed
out and the SMTP URL has to be set again. Anyone with shell access and the root key can read
all of these. Two things stay outside the vault, because it cannot open without them: the root
key and the database URLs.

## Credits

Several of these ideas come from [Paperclip](https://github.com/paperclipai/paperclip)
(MIT): Workspace and personal scopes with no fallback between people, values that can be
written but never read back, a metadata-only list, a value-free access event for every
use, and redacting a delivered value wherever it shows up in a log. Direx adds a data key
per Workspace with each value bound to its row, and keeps values away from agents
entirely.
