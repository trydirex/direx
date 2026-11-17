// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

export const read = () => readFileSync("x", "utf8");
