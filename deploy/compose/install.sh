#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Installs Direx on a server with Docker and Compose: Postgres and Direx from the published image,
# migrations applied, mail set up, and the link that makes the first Server admin. Safe to run
# again: it keeps .env and every password, and skips what is already done.
#
#   sh install.sh --version v0.1.0                          private: Direx on 127.0.0.1:3000
#   sh install.sh --version v0.1.0 --public direx.example.com   Caddy with HTTPS on that domain
#   sh install.sh --mail                                    set up mail again, then restart Direx
#   sh install.sh --tracking track.example.com              tracked links on customers' domains
#
# --tracking names the host customers point their tracking domains at by CNAME; its DNS must reach
# this server. It can be added to an installed server, with or without --public.
#
# It asks for the public address, the From address of mail, the service that sends it and its
# sign-in. Mail is stored only after it logs in and a test email goes out. In CI (CI=true) it reads
# DIREX_INSTALL_BASE_URL, DIREX_INSTALL_MAIL_FROM and DIREX_INSTALL_SMTP_URL instead, and sends the
# test email to DIREX_INSTALL_MAIL_TEST_TO when that is set.
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
MAIL_AGAIN=""
TRACKING=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --public) DOMAIN="${2:-}"; shift 2 ;;
    --mail) MAIL_AGAIN=1; shift ;;
    --tracking) TRACKING="${2:-}"; shift 2 ;;
    *) fail "unknown option $1" "run: sh install.sh --version <release tag>" ;;
  esac
done

# Agencies read "SMTP" as their campaign sender, so say what this mail is, once.
TOLD=""
purpose() {
  [ -n "$TOLD" ] && return
  TOLD=1
  say "Direx sends sign-in links, invites and notices to Admins from one address for the whole server."
  say "Campaign email doesn't use it: each Workspace sends from its own email accounts."
}

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

# Stores smtp.url from stdin, but only once it logs in (and, with --test-to, sends). Exits 1 when the
# check fails, with one line saying why, and 2 when it can't run at all.
# With its dependencies: Postgres is already up, and a mail server run beside Direx (CI's greenmail)
# has to be up for the check to reach it.
store_mail() { # store_mail [secrets.ts flags]
  $DC run --rm -T direx bun apps/api/src/secrets.ts set smtp.url "$@"
}

# Sets host, port, user, pass and tls from a provider's known settings and what the person types.
# Microsoft 365 isn't offered: it no longer takes a password for SMTP.
choose_provider() {
  printf '%s\n' "Which service sends it?" "  1) Gmail or Google Workspace" "  2) Resend" "  3) Postmark" "  4) Amazon SES" "  5) Another SMTP server" >/dev/tty
  case "$(ask "" "Number")" in
    1)
      host=smtp.gmail.com port=465 tls=tls
      user=$(ask "" "Gmail address")
      # Google shows app passwords in groups of four; the spaces aren't part of it.
      pass=$(ask "" "App password, made at myaccount.google.com/apppasswords (not shown)" secret | tr -d ' ')
      ;;
    2)
      host=smtp.resend.com port=465 tls=tls user=resend
      pass=$(ask "" "Resend API key (not shown)" secret)
      ;;
    3)
      host=smtp.postmarkapp.com port=587 tls=tls
      pass=$(ask "" "Postmark server API token (not shown)" secret)
      user=$pass
      ;;
    4)
      host="email-smtp.$(ask "" "AWS region, for example eu-west-1").amazonaws.com" port=465 tls=tls
      user=$(ask "" "SES SMTP user name")
      pass=$(ask "" "SES SMTP password (not shown)" secret)
      ;;
    5)
      host=$(ask "" "SMTP host")
      # The password never crosses the network unencrypted: TLS is required, except for a relay on
      # this machine. For a relay elsewhere without TLS, paste its URL into: secrets.ts set smtp.url
      case "$host" in
        localhost | 127.* | ::1 | "[::1]") tls=any ;;
        *) tls=tls ;;
      esac
      port=$(ask "" "Port, for example 465 or 587")
      user=$(ask "" "User name")
      pass=$(ask "" "Password (not shown)" secret)
      ;;
    *) return 1 ;;
  esac
}

# The mail step. In CI the whole URL comes from the environment. Otherwise a person picks a service
# and signs in, and gets three tries: a check that fails, or a test email they didn't see, asks again.
# Nothing is stored until they say the test email arrived, so mail that worked before stays.
mail_step() {
  say "setting up mail"
  purpose
  if [ "${CI:-}" = "true" ]; then
    smtp=$(ask DIREX_INSTALL_SMTP_URL "")
    [ -n "$smtp" ] || fail "no SMTP URL given" "set DIREX_INSTALL_SMTP_URL and run install.sh again"
    if [ -n "${DIREX_INSTALL_MAIL_TEST_TO:-}" ]; then set -- --test-to "$DIREX_INSTALL_MAIL_TEST_TO"; else set --; fi
    printf %s "$smtp" | store_mail "$@" || fail "mail isn't working, so it wasn't stored" "fix DIREX_INSTALL_SMTP_URL, then run: sh install.sh --mail"
    smtp=""
    return
  fi
  to=$(ask "" "Your email address, for one test email")
  [ -n "$to" ] || fail "no address for the test email" "run: sh install.sh --mail"
  sent="" tries=0
  while [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    if ! choose_provider; then
      say "that isn't one of the numbers"
      continue
    fi
    rc=0
    parts=$(printf '%s\n%s\n%s\n%s\n%s' "$host" "$port" "$user" "$pass" "$tls")
    pass=""
    printf '%s\n' "$parts" | store_mail --parts --test-to "$to" --check-only || rc=$?
    case "$rc" in
      0) ;;
      1) parts=""; say "nothing was stored; try again"; continue ;;
      *) parts=""; fail "mail couldn't be checked" "see the line above, then run: sh install.sh --mail" ;;
    esac
    sent=1
    case "$(ask "" "A test email went to $to from $(envget DIREX_MAIL_FROM). Did it arrive, showing that From address? [y/N]")" in
      y | Y | yes | Yes)
        # Logs in once more, then stores.
        printf '%s\n' "$parts" | store_mail --parts || { parts=""; fail "mail stopped working before it was stored" "run: sh install.sh --mail"; }
        parts=""
        return
        ;;
    esac
    parts=""
    say "Nothing was stored. Look in spam first. Some services, Gmail among them, put the account's own address in the From instead."
    say "To send from another address, edit DIREX_MAIL_FROM in .env and run: sh install.sh --mail"
  done
  if [ -n "$sent" ]; then
    fail "mail logs in and sends, but the test email didn't arrive as it should, so nothing was stored" "fix the From or the service, then run: sh install.sh --mail"
  fi
  fail "mail still isn't working after 3 tries, and nothing was stored" "check the service's SMTP settings, then run: sh install.sh --mail"
}

# Sets KEY=value, adding the line to an .env written before the key existed.
putkey() { # putkey <key> <value>
  if grep -q "^$1=" .env; then setkey "$1" "$2"; else printf '%s=%s\n' "$1" "$2" >>.env; fi
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
  purpose
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

# Tracked links (ADR 0035): the CNAME target, the Compose profile and the Caddy sites.
if [ -n "$TRACKING" ]; then
  current=$(envget DIREX_TRACKING_TARGET)
  if [ -n "$current" ] && [ "$current" != "$TRACKING" ]; then
    fail ".env already names tracking target $current" "to change it, edit DIREX_TRACKING_TARGET in .env yourself; customers' CNAMEs point at the old one"
  fi
  case "$TRACKING" in *[!a-z0-9.-]* | "" | .* | *.) fail "--tracking needs a hostname such as track.example.com" "run install.sh again with a lowercase hostname" ;; esac
  putkey DIREX_TRACKING_TARGET "$TRACKING"
  profiles=$(envget COMPOSE_PROFILES)
  case ",$profiles," in *,tracking,*) ;; *) putkey COMPOSE_PROFILES "${profiles:+$profiles,}tracking" ;; esac
fi
if [ -n "$(envget DIREX_DOMAIN)" ] && [ -n "$(envget DIREX_TRACKING_TARGET)" ]; then
  putkey DIREX_CADDY_SITES '*.caddy'
elif [ -n "$(envget DIREX_TRACKING_TARGET)" ]; then
  putkey DIREX_CADDY_SITES tracking.caddy
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

# Direx was stopped before migrations, so the start below reads whatever mail this stores.
if [ -z "$MAIL_AGAIN" ] && $DC run --rm --no-deps -T direx bun apps/api/src/secrets.ts list 2>/dev/null | grep -q '^smtp\.url: set'; then
  say "mail is already set up; to change it: sh install.sh --mail"
else
  mail_step
fi

say "starting Direx"
$DC up -d --wait direx || fail "Direx didn't start" "see: $DC logs direx"
if [ -n "$(envget DIREX_DOMAIN)" ] || [ -n "$(envget DIREX_TRACKING_TARGET)" ]; then
  say "starting Caddy"
  $DC up -d --force-recreate caddy || fail "Caddy didn't start" "check that ports 80 and 443 are free and the domain points here, then see: $DC logs caddy"
fi

# Until someone opens the link below, doctor reports that there is no Server admin. That one
# failure is expected here; any other stops the install.
say "checking the installation"
report=$($DC exec -T direx bun run doctor 2>&1) || true
printf '%s\n' "$report"
if printf '%s\n' "$report" | grep '^FAIL ' | grep -qv '^FAIL this server has a Server admin:'; then
  fail "a check failed" "follow the fix printed above, then run install.sh again"
fi

say "the first Server admin"
if ! $DC exec -T direx bun run server-admin --invite; then
  say "no new link: this server already has a Server admin"
fi

say "done. Direx is running at $(envget DIREX_BASE_URL)"
