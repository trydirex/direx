// SPDX-License-Identifier: AGPL-3.0-only
// Ignores shutdown and SIGTERM, so only SIGKILL stops it.
import { serveRaw } from "./raw-lib";

serveRaw({ stubborn: true });
