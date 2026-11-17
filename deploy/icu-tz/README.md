# Time zone data for Bun

Bun carries its own copy of the world's time zone rules, and it lags behind. Bun 1.4.2 and 1.4.4
(ICU 78.3) still put Vancouver on UTC-8 after 1 November 2026, when British Columbia stays on UTC-7
all year, so every weekly slot and campaign slot there would land an hour late.

`zoneinfo64.res` here is ICU's build of tz release **2026e**, from
`https://github.com/unicode-org/icu-data/tree/main/tzdata/icunew/2026e/44/le/`. Every way Direx
starts Bun (the `dev`, `start`, `test` and `test:coverage` scripts, and the Docker image) sets
`ICU_TIMEZONE_FILES_DIR` to this folder, and Bun then reads the rules from this file. The variable
must be set when the process starts; setting it from code does nothing.

## Refreshing it

When IANA publishes a new tz release and ICU's build of it appears in `icu-data`:

```
curl -fsSL -o deploy/icu-tz/zoneinfo64.res \
  https://raw.githubusercontent.com/unicode-org/icu-data/main/tzdata/icunew/<release>/44/le/zoneinfo64.res
```

Then change the release name above and run `bun run test`. Once Bun ships data at least this
new, this folder and the variable can go.
