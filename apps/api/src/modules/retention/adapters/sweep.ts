// SPDX-License-Identifier: AGPL-3.0-only
// The daily retention sweep lives beside the retention list in packages/db, which runs each table's definer.
export { sweepRetention } from "@direx/db";
