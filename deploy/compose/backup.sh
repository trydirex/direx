#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Backs up the database: a pg_dump encrypted with age to a public key, then uploaded with rclone.
# Run it from cron on the server (see "Backups" in README.md). Only after the
# upload does it write state/last-backup, which doctor reads to say how old the last backup is.
#
#   sh backup.sh
#
# Reads DIREX_BACKUP_REMOTE (an rclone remote and folder, such as b2:direx-backups, or a local
# folder) and DIREX_BACKUP_AGE_RECIPIENT (an age public key) from the environment or .env.
# The dump holds no Credential in the clear: they stay encrypted under the vault's root key, which
# is never part of a backup. Keep that key apart from the dumps.
#
# DC names the Compose command, so the same script can back up a development database:
#   DC="docker compose -f ../../docker-compose.yml" sh backup.sh
set -eu

cd "$(dirname "$0")"
DC="${DC:-docker compose}"

say() { printf 'backup: %s\n' "$*"; }
fail() {
  printf 'backup: %s\n  next: %s\n' "$1" "$2" >&2
  exit 1
}

envget() { if [ -f .env ]; then sed -n "s/^$1=//p" .env | head -n 1; fi; }

remote="${DIREX_BACKUP_REMOTE:-$(envget DIREX_BACKUP_REMOTE)}"
recipient="${DIREX_BACKUP_AGE_RECIPIENT:-$(envget DIREX_BACKUP_AGE_RECIPIENT)}"
[ -n "$remote" ] || fail "DIREX_BACKUP_REMOTE is not set" "set it in .env, for example DIREX_BACKUP_REMOTE=b2:direx-backups"
[ -n "$recipient" ] || fail "DIREX_BACKUP_AGE_RECIPIENT is not set" "make a key with age-keygen, keep the identity off this server, and put its public key in .env"
command -v age >/dev/null 2>&1 || fail "age is not installed" "install it: https://github.com/FiloSottile/age#installation"
command -v rclone >/dev/null 2>&1 || fail "rclone is not installed" "install it: https://rclone.org/install/"

umask 077
dump=$(mktemp)
sealed=$(mktemp)
trap 'rm -f "$dump" "$sealed"' EXIT
name="direx-$(date -u +%Y%m%dT%H%M%SZ).dump.age"

say "dumping the database"
$DC exec -T postgres pg_dump -U direx_owner -Fc direx >"$dump" || fail "pg_dump failed" "see the error above and: $DC logs postgres"
[ -s "$dump" ] || fail "the dump is empty" "check that Postgres is running: $DC ps"

say "encrypting"
age -r "$recipient" -o "$sealed" "$dump" || fail "age couldn't encrypt the dump" "check DIREX_BACKUP_AGE_RECIPIENT is an age public key (age1...)"

say "uploading $name"
rclone copyto "$sealed" "$remote/$name" || fail "the upload failed" "check the remote with: rclone lsf $remote"

# Readable by Direx in its container (doctor), which mounts this folder read-only.
umask 022
mkdir -p state
date -u +%Y-%m-%dT%H:%M:%SZ >state/last-backup
say "done: $remote/$name"
