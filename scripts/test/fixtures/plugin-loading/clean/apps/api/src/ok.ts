// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
export const a = () => import("./local");
export const b = (tx: { execute(q: string): void }) => tx.execute("select 1");
export const c = () => Bun.spawn(["x"], { env: { PATH: process.env.PATH ?? "" } });
export const d = () => spawn("x", [], { env: { HOME: "/tmp" } });
