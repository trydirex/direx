// SPDX-License-Identifier: AGPL-3.0-only
// Echoes every line the host sends to stderr as "RECV <line>".
import { serveRaw } from "./raw-lib";

serveRaw({ spy: true });
