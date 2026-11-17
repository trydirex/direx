// SPDX-License-Identifier: AGPL-3.0-only
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

export const db = drizzle(new pg.Pool());
