// SPDX-License-Identifier: AGPL-3.0-only
import { withWorkspace } from "@direx/db";

export const list = (id: string) => withWorkspace(id, async () => []);
