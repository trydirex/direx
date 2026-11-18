#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Restores a backup made by backup.sh into this install, replacing its database: decrypts the dump,
# restores it, puts back the vault's root key the backed-up server ran with, applies migrations,
# starts Direx and runs doctor. Run install.sh first on a new server.
#
#   sh restore.sh --replace-database <backup.dump.age> <age identity file> <root key file>
#
# The age identity is the private half of DIREX_BACKUP_AGE_RECIPIENT; the root key is the
# master.key file the backed-up server kept in its data directory. Without that key every stored
# Credential restores as unreadable bytes. Neither is printed.
set -eu

cd "$(dirname "$0")"
DC="${DC:-docker compose}"

say() { printf 'restore: %s\n' "$*"; }
fail() {
  printf 'restore: %s\n  next: %s\n' "$1" "$2" >&2
  exit 1
}

USAGE="sh restore.sh --replace-database <backup.dump.age> <age identity file> <root key file>"
replace=""
if [ "${1:-}" = "--replace-database" ]; then
  replace=yes
  shift
fi
[ $# -eq 3 ] || fail "expected a backup, an age identity and a root key" "run: $USAGE"
backup=$1
identity=$2
key=$3
for f in "$backup" "$identity" "$key"; do
  [ -r "$f" ] || fail "can't read $f" "check the path, then run: $USAGE"
done
[ -n "$replace" ] || fail "this replaces every row in this install's database with $backup" "if that is what you want, run: $USAGE"
command -v age >/dev/null 2>&1 || fail "age is not installed" "install it: https://github.com/FiloSottile/age#installation"

umask 077
dump=$(mktemp)
trap 'rm -f "$dump"' EXIT

say "decrypting $backup"
age -d -i "$identity" -o "$dump" "$backup" || fail "age couldn't decrypt the backup" "check it is the identity whose public key made this backup"

say "starting Postgres"
$DC up -d --wait postgres || fail "Postgres didn't start" "see: $DC logs postgres"

say "stopping Direx"
$DC stop direx || fail "Direx didn't stop" "see: $DC logs direx; do not restore while it is running"

say "replacing the database"
$DC exec -T postgres psql -q -U direx_owner -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS direx WITH (FORCE)' -c 'CREATE DATABASE direx OWNER direx_owner' >/dev/null ||
  fail "the database wasn't replaced" "see: $DC logs postgres"
$DC exec -T postgres pg_restore -U direx_owner -d direx --exit-on-error <"$dump" ||
  fail "the restore stopped on an error" "see the error above; the database is incomplete, so run restore.sh again once it is fixed"

# The key file in the data volume, written by the user Direx runs as and readable by no one else.
say "putting back the root key"
# DIREX_DATA_DIR is escaped so the shell in the container expands it, from compose.yml.
$DC run --rm --no-deps -T --entrypoint sh direx -c "umask 077 && cat >\"\$DIREX_DATA_DIR/master.key\"" <"$key" ||
  fail "the root key wasn't written" "see the error above"

say "applying migrations"
$DC run --rm --no-deps direx bun run db:migrate || fail "migrations didn't apply" "see the error above"

say "starting Direx"
$DC up -d --wait direx || fail "Direx didn't start" "see: $DC logs direx"

# A backup taken before anyone claimed the server has no Server admin, and this install's backups
# start only once cron runs backup.sh. Any other failure means the restore isn't usable yet.
say "checking the installation"
report=$($DC exec -T direx bun run doctor 2>&1) || true
printf '%s\n' "$report"
if printf '%s\n' "$report" | grep '^FAIL ' | grep -v '^FAIL this server has a Server admin:' | grep -qv '^FAIL last backup under 26 hours old:'; then
  fail "a check failed" "follow the fix printed above"
fi
# A doctor that crashed prints no FAIL line, and no ok line for the key this restore put back.
printf '%s\n' "$report" | grep -q '^ok root key$' || fail "doctor didn't finish" "see its output above and: $DC logs direx"
say "done"
