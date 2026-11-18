#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Installs Direx on a server with Docker and Compose: Postgres and Direx from the published image,
# migrations applied, mail set up, and the link that makes the first Server admin. Safe to run
# again: it keeps .env and every password, and skips what is already done.
#
#   sh install.sh --version v0.1.0                          private: Direx on 127.0.0.1:3000
#   sh install.sh --version v0.1.0 --public direx.example.com   Caddy with HTTPS on that domain
#
# It asks for the public address, the From address of mail and the SMTP URL. In CI (CI=true) it
# reads DIREX_INSTALL_BASE_URL, DIREX_INSTALL_MAIL_FROM and DIREX_INSTALL_SMTP_URL instead.
# Nothing it prints holds a password or the SMTP URL.
set -eu

cd "$(dirname "$0")"
DC="docker compose"

say() { printf 'install: %s\n' "$*"; }
fail() {
  printf 'install: %s\n  next: %s\n' "$1" "$2" >&2
  exit 1
}

VERSION=""
DOMAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --public) DOMAIN="${2:-}"; shift 2 ;;
    *) fail "unknown option $1" "run: sh install.sh --version <release tag>" ;;
  esac
done

# Asks a question, or reads the CI variable. A secret question doesn't echo what is typed.
ask() { # ask <ci variable> <prompt> [secret]
  if [ "${CI:-}" = "true" ]; then
    eval "printf %s \"\${$1:-}\""
    return
  fi
  printf '%s: ' "$2" >/dev/tty
  if [ "${3:-}" = "secret" ]; then
    stty -echo </dev/tty
    IFS= read -r answer </dev/tty || answer=""
    stty echo </dev/tty
    printf '\n' >/dev/tty
  else
    IFS= read -r answer </dev/tty || answer=""
  fi
  printf %s "$answer"
}

# 48 hex characters, safe in a URL without escaping.
password() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }

# Replaces one KEY=FILL line of .env. The value reaches sed on stdin, never in a process list, with
# the characters sed treats specially escaped.
fill() { # fill <key> <value>
  value=$(printf %s "$2" | sed 's/[&|\\]/\\&/g')
  printf 's|^%s=FILL$|%s=%s|\n' "$1" "$1" "$value" | sed -i -f - .env
}

envget() { sed -n "s/^$1=//p" .env | head -n 1; }

# Sets an optional KEY= line of .env, empty in the template.
setkey() { # setkey <key> <value>
  value=$(printf %s "$2" | sed 's/[&|\\]/\\&/g')
  printf 's|^%s=.*$|%s=%s|\n' "$1" "$1" "$value" | sed -i -f - .env
}

say "checking Docker and Compose"
command -v docker >/dev/null 2>&1 || fail "Docker is not installed" "install Docker Engine: https://docs.docker.com/engine/install/"
$DC version >/dev/null 2>&1 || fail "Docker Compose is not installed" "install the Compose plugin: https://docs.docker.com/compose/install/linux/"

if [ ! -f .env ]; then
  [ -n "$VERSION" ] || fail "no version given" "run: sh install.sh --version <release tag>"
  say "writing .env"
  if [ -n "$DOMAIN" ]; then
    base_url="https://$DOMAIN"
  else
    base_url=$(ask DIREX_INSTALL_BASE_URL "The address people will open, for example https://direx.example.com")
  fi
  [ -n "$base_url" ] || fail "no address given" "run install.sh again and give the address people will open"
  mail_from=$(ask DIREX_INSTALL_MAIL_FROM "The From address of sign-in mail, for example Direx <signin@example.com>")
  [ -n "$mail_from" ] || fail "no From address given" "run install.sh again and give the From address"
  owner_pw=$(password)
  app_pw=$(password)
  umask 077
  cp .env.template .env
  fill DIREX_VERSION "$VERSION"
  fill DIREX_BASE_URL "$base_url"
  fill DIREX_MAIL_FROM "$mail_from"
  fill POSTGRES_PASSWORD "$owner_pw"
  fill DIREX_DB_OWNER_URL "postgres://direx_owner:$owner_pw@postgres:5432/direx"
  fill DIREX_DB_APP_URL "postgres://direx_app:$app_pw@postgres:5432/direx"
  if [ -n "$DOMAIN" ]; then
    setkey DIREX_DOMAIN "$DOMAIN"
    setkey COMPOSE_PROFILES public
  fi
  if grep -q '=FILL$' .env; then
    fail ".env still has a FILL" "delete .env and run install.sh again"
  fi
elif [ -n "$VERSION" ] && [ "$VERSION" != "$(envget DIREX_VERSION)" ]; then
  fail ".env already names version $(envget DIREX_VERSION)" "to change versions, edit DIREX_VERSION in .env yourself"
elif [ -n "$DOMAIN" ] && [ "$DOMAIN" != "$(envget DIREX_DOMAIN)" ]; then
  fail ".env was written without this domain" "to change how Direx is reached, edit DIREX_DOMAIN, COMPOSE_PROFILES and DIREX_BASE_URL in .env yourself"
fi

# backup.sh writes here and Direx reads it; made now so Docker doesn't create it as root. Readable
# by all, whatever umask wrote .env, because Direx reads it as its own user, not this one.
mkdir -p state || fail "the backup state directory couldn't be created" "check permissions on this directory, then run install.sh again"
state_mode=$(stat -c '%a' state) || fail "the backup state directory's permissions couldn't be read" "check state, then run install.sh again"
if [ "$state_mode" != "755" ]; then
  chmod 755 state || fail "the backup state directory needs mode 755" "have its owner run chmod 755 state, then run install.sh again"
fi

image="ghcr.io/trydirex/direx:$(envget DIREX_VERSION)"
if docker image inspect "$image" >/dev/null 2>&1; then
  say "using the image already on this server"
else
  say "pulling $image"
  $DC pull || fail "the image didn't download" "check the version in .env and that this server reaches ghcr.io"
fi

say "starting Postgres"
$DC up -d --wait postgres || fail "Postgres didn't start" "see: $DC logs postgres"

# Finish all old writers before a backfill changes what the new version reads. Leave Direx stopped
# if migration fails: fix the failure and rerun this installer before restoring service.
say "stopping Direx before migrations"
$DC stop direx || fail "Direx didn't stop" "see: $DC logs direx; do not migrate while old writers are running"

say "applying migrations"
$DC run --rm --no-deps direx bun run db:migrate || fail "migrations didn't apply" "see the error above"

# Migration 0000 makes the app role without a password; this sets the one in .env each run.
say "setting the app role's password"
app_pw=$(envget DIREX_DB_APP_URL | sed -n 's|^postgres://direx_app:\([^@]*\)@.*|\1|p')
printf "ALTER ROLE direx_app PASSWORD '%s';\n" "$app_pw" |
  $DC exec -T postgres psql -q -U direx_owner -d direx -v ON_ERROR_STOP=1 >/dev/null ||
  fail "the app role's password wasn't set" "see: $DC logs postgres"

if $DC run --rm --no-deps -T direx bun apps/api/src/secrets.ts list 2>/dev/null | grep -q '^smtp\.url: set'; then
  say "mail is already set up"
else
  say "setting up mail"
  smtp=$(ask DIREX_INSTALL_SMTP_URL "SMTP URL, for example smtps://user:password@smtp.example.com:465 (not shown)" secret)
  [ -n "$smtp" ] || fail "no SMTP URL given" "run install.sh again and give the SMTP URL"
  printf %s "$smtp" | $DC run --rm --no-deps -T direx bun apps/api/src/secrets.ts set smtp.url >/dev/null ||
    fail "the SMTP URL wasn't stored" "run install.sh again"
  smtp=""
fi

say "starting Direx"
$DC up -d --wait direx || fail "Direx didn't start" "see: $DC logs direx"
if [ -n "$(envget DIREX_DOMAIN)" ]; then
  say "starting Caddy for $(envget DIREX_DOMAIN)"
  $DC up -d caddy || fail "Caddy didn't start" "check that ports 80 and 443 are free and the domain points here, then see: $DC logs caddy"
fi

# Until someone opens the link below, doctor reports that there is no Server admin, and until cron
# runs backup.sh, that there is no backup. Those two failures are expected here; any other stops
# the install.
say "checking the installation"
report=$($DC exec -T direx bun run doctor 2>&1) || true
printf '%s\n' "$report"
if printf '%s\n' "$report" | grep '^FAIL ' | grep -v '^FAIL this server has a Server admin:' | grep -qv '^FAIL last backup under 26 hours old:'; then
  fail "a check failed" "follow the fix printed above, then run install.sh again"
fi

say "the first Server admin"
if ! $DC exec -T direx bun run server-admin --invite; then
  say "no new link: this server already has a Server admin"
fi

say "done. Direx is running at $(envget DIREX_BASE_URL)"
