// SPDX-License-Identifier: AGPL-3.0-only
export const run = () => Bun.spawn(["x"], { env: { ...process.env, A: "1" } });
