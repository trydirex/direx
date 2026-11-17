# Process roles

A Direx process starts in one of three roles, set by `DIREX_ROLE` (ADR 0027 rule 002):

| Role | Serves | Works and schedules queues | Where |
|---|---|---|---|
| `all` (default) | the whole app | yes | self-host and cloud |
| `api` | the whole app | no: it creates queues and sends jobs only | cloud only |
| `worker` | `/health` only, 404 on every other path | yes | cloud only |

A self-hosted Direx runs as one process. Leave `DIREX_ROLE` unset and start it with `bun run start`.

## Running cloud as two services

Run the same image twice, against the same database:

```
DIREX_DEPLOYMENT=cloud DIREX_ROLE=api    bun run start
DIREX_DEPLOYMENT=cloud DIREX_ROLE=worker bun run start   # or: bun run worker
```

The two sides share only Postgres and object storage (rule 005), so `api` and `worker` refuse to
start unless:

- `DIREX_DEPLOYMENT` is `cloud`;
- the root key is in `DIREX_MASTER_KEY`, not in a file or generated under the data directory, so
  every process reads the same key;
- `media.s3` is set (see [deployment secrets](deployment-secrets.md#object-storage-for-uploaded-files)),
  so both sides read and write the same files.

Each refusal names what to change. `all` refuses none of them.

## Stopping

Both roles drain on SIGTERM or SIGINT, as `all` does: `api` finishes the requests it accepted, and
`worker` finishes running jobs and agent runs, for up to 330 seconds. Give each service a stop grace
above that, for example `stop_grace_period: 6m` in Docker Compose or `TimeoutStopSec=360` under
systemd.

An orchestrator can probe `GET /health` on either role.
