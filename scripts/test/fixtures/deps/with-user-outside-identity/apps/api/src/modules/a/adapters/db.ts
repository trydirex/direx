// SPDX-License-Identifier: AGPL-3.0-only
import { withUser } from "@direx/db/user";

export const mine = (id: string) => withUser(id, async () => []);
