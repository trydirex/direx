# Direx on a server

`install.sh` sets up Direx with Docker Compose. See "Run it on a server" in the main
[README](../../README.md) for the steps.

| File | What it is |
|---|---|
| `install.sh` | The installer. Safe to run again |
| `compose.yml` | Postgres and Direx; Caddy under the `public` profile |
| `Caddyfile` | HTTPS for the domain given to `--public` |
| `sites/` | Caddy's sites: `public.caddy` for the app, `tracking.caddy` for tracked links |
| `.env.template` | Copied to `.env` by the installer, which fills in the values. Never commit `.env` |
| `ci.compose.yml` | CI only: a test mail server for `.github/workflows/install.yml` |

After the install, run Compose from this folder:

```
docker compose ps
docker compose logs -f direx
docker compose exec direx bun run doctor
```

To change the service that sends sign-in mail, run `sh install.sh --mail`. It logs in and sends a
test email before it stores anything, then restarts Direx.

Keys and other secrets go into the vault, typed by a person, with the value on stdin:

```
docker compose exec -T direx bun apps/api/src/secrets.ts set provider.anthropic
```

A stop lets Direx finish what is already sending, for up to six minutes.

## Tracked links

To count clicks on Campaign links on your customers' own domains, name a hostname of yours whose DNS
reaches this server:

```
sh install.sh --tracking track.example.com
```

Each Workspace then adds its tracking domain under Settings, Tracking domains, and sets the two
records that page shows:

- a CNAME from its domain to `track.example.com`
- a TXT record at `_direx-tracking.<its domain>` holding the value shown

Check marks the domain verified once both records match and a test HTTPS connection works. Caddy gets
a certificate for a domain on its first visit, and only for one Direx has checked. On a tracking
domain, only `/t/` links answer; the app, the API and every other path are a 404, and no access log
is written.
