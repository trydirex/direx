// SPDX-License-Identifier: AGPL-3.0-only
// One LISTEN on its own connection, outside the pool: a pooled connection goes back after each
// transaction and would lose the subscription. Plugin installs use it (ADR 0026 rule 004), so every
// API and worker process hears when the installed list changes. Nothing may depend on hearing it:
// each call checks the database itself.
import pg from "pg";

const CHANNEL = /^[a-z_]{1,63}$/;

/** Calls onNotify with each payload on the channel until the returned stop is called. */
export async function listen(channel: string, onNotify: (payload: string) => void, url = process.env.DIREX_DB_APP_URL): Promise<() => Promise<void>> {
  if (!CHANNEL.test(channel)) throw new Error(`listen: ${JSON.stringify(channel)} is not a channel name`);
  if (!url) throw new Error("DIREX_DB_APP_URL is not set");
  const client = new pg.Client({ connectionString: url });
  client.on("notification", (n) => {
    if (n.channel === channel) onNotify(n.payload ?? "");
  });
  // A dropped connection ends the subscription; the caller's own checks still hold without it.
  client.on("error", () => {});
  await client.connect();
  await client.query(`LISTEN ${channel}`);
  return async () => {
    await client.end();
  };
}
