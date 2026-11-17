// SPDX-License-Identifier: AGPL-3.0-only
// Reports a manifest that differs from the one the host loaded.
import { behaveManifest } from "./manifest";
import { serveRaw } from "./raw-lib";

serveRaw({ manifest: { ...behaveManifest, version: "9.9.9" } });
