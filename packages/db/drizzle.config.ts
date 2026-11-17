// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// drizzle-kit runs on Node, which does not see the .env that `bun run` loaded.
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

// Migrations run as the owner role only.
export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/schema.ts", "./src/schema-agents.ts", "./src/schema-plans.ts", "./src/schema-outreach.ts", "./src/schema-campaigns.ts", "./src/schema-social.ts", "./src/schema-rules.ts", "./src/schema-prospecting.ts", "./src/schema-newsletter.ts", "./src/schema-seo.ts", "./src/schema-media.ts", "./src/schema-clips.ts", "./src/schema-lessons.ts", "./src/schema-ask.ts", "./src/schema-placement.ts", "./src/schema-voice.ts", "./src/schema-competitors.ts", "./src/schema-docs.ts", "./src/schema-door.ts", "./src/schema-retention.ts", "./src/auth-schema.ts"],
  out: "./migrations",
  dbCredentials: { url: process.env.DIREX_DB_OWNER_URL! },
});
