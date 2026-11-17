# Running Direx on a Claude Code or Codex subscription

Self-host only. Direx cloud uses its own keys and shows none of this.

## Setup

1. Install the CLI yourself on the machine running Direx. Direx installs nothing and ships no image
   with a CLI inside. You also need Linux and `bwrap` (bubblewrap), or the Docker setup below.
2. Start the app with `bun run dev` from the repo root.
3. Open **Models**, and under **Which AI runs** press **Sign in just for me** or **Sign in for this
   Workspace**. Scheduled and other background work only uses a Workspace sign-in.
4. Follow the link. Claude Code gives you a code to paste back; Codex shows a code to enter there.
5. Press **Test**, then choose the AI for the Workspace, and for any agent that should differ.

## What Direx does with it

Direx keeps its own loop and asks the CLI one question per step, tools off, in a sandbox with an
empty home, no host files and network access only to that provider. If the sandbox can't run,
Direx refuses and says why. There is no way to run without it.

Calls are recorded at 0 cents. Run limits still apply, and a run that hits the subscription's limit
waits for the reset.

## Models

| AI | Checked against a real subscription | Listed, not yet checked |
|---|---|---|
| Claude Code | `claude-haiku-5-5` | `claude-sonnet-5-5`, `claude-opus-5-5` |
| Codex | `gpt-6-luna` | `gpt-6-sol`, `gpt-6-astra` |

## Docker

`deploy/docker/` runs Direx in a container where the sandbox works. Direx ships no CLI, so first
uncomment the install line for yours in `deploy/docker/Dockerfile`. Then, from the repo root:

```
docker compose up -d postgres
docker compose -f deploy/docker/compose.yml up --build
```

It runs the same dev mode as `bun run dev`, with your `.env`, on the host network. The vault's
master key lives in the `direx-data` volume, so back that volume up with the database.

Default Docker settings refuse the sandbox, and Direx then refuses to use the CLI and says so. The
compose file changes these settings, and each one is needed:

| Setting | Why |
|---|---|
| `seccomp=./seccomp-bwrap.json` | Docker's default profile, plus the namespace and mount calls `bwrap` needs, without the `SYS_ADMIN` capability |
| `apparmor=unconfined` | Docker's AppArmor profile blocks the sandbox's mounts |
| `systempaths=unconfined` | Docker masks parts of `/proc`, and the kernel then refuses the sandbox its own `/proc` |
| `user: bun`, `cap_drop: [ALL]`, `no-new-privileges` | Keep the container tighter than Docker's default; unmasked `/proc` is safe only for a non-root user |

The first three loosen the container a little: code already inside it gets more kernel calls to
try an escape with. They don't give the CLI anything, because each call still runs in its own
sandbox. If you'd rather not change them, use an API key.

On Ubuntu 24.04 and later, the host also blocks unprivileged user namespaces by default. Allow them
with `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0` (and a file in
`/etc/sysctl.d/` to keep it), or use an API key.

Checked on Linux with Docker 29.9 and Claude Code 2.1.317. Codex hasn't been run in the container.

## Mac

The sandbox is Linux only, so use the Docker setup above with Docker Desktop. That hasn't been
checked yet; `network_mode: host` needs host networking turned on in Docker Desktop's settings.

## Checking by hand

`apps/api/src/modules/models/cli-smoke.ts` runs four checks against a real sign-in. Its header shows how.
