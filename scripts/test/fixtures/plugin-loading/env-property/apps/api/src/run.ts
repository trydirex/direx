// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
export const run = () => spawn("x", [], { env: process.env });
