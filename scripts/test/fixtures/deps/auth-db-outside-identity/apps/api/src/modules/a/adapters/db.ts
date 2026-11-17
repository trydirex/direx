// SPDX-License-Identifier: AGPL-3.0-only
import { authDb } from "@direx/db/auth";

export const db = () => authDb();
