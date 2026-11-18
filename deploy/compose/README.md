# Direx on a server

`install.sh` sets up Direx with Docker Compose. See "Run it on a server" in the main
[README](../../README.md) for the steps.

| File | What it is |
|---|---|
| `install.sh` | The installer. Safe to run again |
| `backup.sh`, `restore.sh` | A backup of the database, and a restore of one into this install. See [Backups](#backups) |
| `compose.yml` | Postgres and Direx; Caddy under the `public` profile |
| `Caddyfile` | HTTPS for the domain given to `--public` |
| `.env.template` | Copied to `.env` by the installer, which fills in the values. Never commit `.env` |
| `ci.compose.yml` | CI only: a test mail server for `.github/workflows/install.yml` |

After the install, run Compose from this folder:

```
docker compose ps
docker compose logs -f direx
docker compose exec direx bun run doctor
```

Keys and other secrets go into the vault, typed by a person, with the value on stdin:

```
docker compose exec -T direx bun apps/api/src/secrets.ts set provider.anthropic
```

A stop lets Direx finish what is already sending, for up to six minutes.

## Backups

A backup has two halves, kept in different places:

- **The database,** dumped each night by `backup.sh`, encrypted with [age](https://github.com/FiloSottile/age)
  and uploaded with [rclone](https://rclone.org). It holds your contacts and who opted out.
- **The vault's root key,** the `master.key` file in the `direx-data` volume. Stored Credentials
  are encrypted with it, so a dump without it restores every Credential as unreadable bytes. Copy
  it once into a password manager. It never goes in the bucket.

Set up once, on the server, from this folder:

1. Make a bucket with any provider rclone supports, and a key for it that can write and list but
   not delete, so a stolen server can't erase its own backups. A lifecycle rule on the bucket
   removes old dumps (30 days is plenty). Then `rclone config` to add it as a remote.
2. Make an age key **on your own computer**: `age-keygen -o direx-backup.key`. Put that file in
   your password manager; it is the only way to read a backup. Only its public key, the
   `age1...` line it prints, goes on the server.
3. Copy the root key out once and put it in the password manager too:
   `(umask 077; docker compose run --rm --no-deps -T --entrypoint sh direx -c 'cat "$DIREX_DATA_DIR/master.key"' >master.key)`,
   then delete `master.key` from the server.
4. In `.env`, set `DIREX_BACKUP_REMOTE` (the remote and folder, such as `b2:direx-backups`) and
   `DIREX_BACKUP_AGE_RECIPIENT` (the `age1...` key).
5. Run `sh backup.sh` once, then run it each night from cron (`crontab -e`):

   ```
   17 3 * * * cd /path/to/deploy/compose && sh backup.sh >>state/backup.log 2>&1
   ```

`doctor` fails once the last backup is more than 26 hours old. Until the first `backup.sh` run it
reports that failure too; `install.sh` expects it, so it is not an install error.

To restore, on a fresh install of the same or a newer version (or to test a backup, on a second
server), with the dump, the age key and the root key copied over:

```
sh restore.sh --replace-database direx-<time>.dump.age direx-backup.key master.key
```

It replaces the whole database, puts the root key back, applies migrations, starts Direx and runs
`doctor`. Delete the two key files from that server afterwards. Restore a backup once before it
holds anything you can't lose, and then once a month.
