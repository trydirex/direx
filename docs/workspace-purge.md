# Purging a deleted Workspace, and restoring a backup

When an Owner deletes a Workspace, Direx stops its work at once and keeps its data for 30 days, so
the Owner can still download an export. After that a Server admin can purge it: its rows, media
files, export ZIPs and queued jobs are removed, and a receipt records what went (ADR 0030).

After a deleted Workspace is purged, Direx keeps no record of what it sent or of consent. Keep this
export for at least 6 years. Proving consent and honoured opt-outs is the sender's duty, and the
export holds the Workspace's Actions, approvals, Action events, eligibility records, People and
plaintext opt-outs for that.

## Running the purge

On the server, from the repository root, where `.env` is:

```
bun run server-admin purge <workspace-id>
```

This prints how many rows of each table, how many queued jobs and how many stored files the purge
would remove, and changes nothing. To purge, run it again with `--confirm`. It prints the receipt as
one line of JSON when it is done.

The command connects as the database owner (`DIREX_DB_OWNER_URL`), the only role that may run the
purge, and reads the vault and the file store the way the server does, so it needs the root key and
the same `DIREX_DATA_DIR` or `media.s3` the server uses.

It refuses, and says why, when the Workspace:

- is the system Workspace, which holds the server's own secrets;
- is not deleted, or was deleted less than 30 days ago;
- has an Action that is not sent, blocked or cancelled. An Action held with an unknown outcome
  counts: it may have reached someone, so a person settles it first;
- was purged already.

If the command stops part way, run it again. It carries on from where it stopped. From the moment
it starts, the Workspace is marked as purging, and no request or job can touch it again.

## What a purge keeps

- **Opt-outs.** Each address that opted out or bounced is kept as a keyed hash (HMAC-SHA256 under
  the vault secret `suppression.key`, made by the first purge that needs it and never changed),
  with the Organization's id and nothing else. A new Workspace in the same Organization still
  can't email those addresses. No other Organization reads them.
- **The receipt**, in `system.purge_receipts`: the Workspace id, who ran it, when it started and
  finished, the files removed, the opt-outs hashed, and the rows removed per table. Counts only,
  never content.

Nothing else is kept. The Workspace's Actions, approvals, Action events, eligibility records,
People, credentials, standing rules, campaigns and plans go with every other row, and then the
Workspace's own row. When it was the last Workspace of its Organization, the Organization goes too.
The opt-out hashes keep the Organization's id even then.

The receipt's `kept` is empty after a normal purge. It names what stayed only when something outside
the Workspace still pointed at it: rows per table, with the Workspace's row kept with its name
cleared, or the Organization row and the table that still references it.

## Backups

On cloud, database backups and object storage versions expire after 35 days. Run self-hosted
servers the same way: keep database backups, and backups of the data directory or bucket, for no
more than 35 days, so a purged Workspace is gone from every copy within 35 days of its purge.

A backup can be older than a purge, so a restore would bring the purged Workspace back. Keep every
purge receipt outside the database backup: the line the command prints, or a regular copy of the
table, for example:

```
psql "$DIREX_DB_OWNER_URL" -Atc "select to_jsonb(r) from system.purge_receipts r" > receipts.jsonl
```

## Restoring a backup

Before the restored server takes any traffic, replay every purge receipt newer than the backup:

1. Keep Direx stopped.
2. Restore the database, and the files if you back those up.
3. Run `bun run db:migrate` if the backup is from an older version.
4. Run `bun run server-admin purge --replay receipts.jsonl`. It lists each Workspace it would purge
   again, and skips those the backup already shows as purged or doesn't hold.
5. Run it again with `--confirm`. A replay purges a Workspace even if the backup shows it live or
   recently deleted, since its receipt says it was purged. It never purges the system Workspace.
6. Start Direx.
