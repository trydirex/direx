// SPDX-License-Identifier: AGPL-3.0-only
// raw-spy for a plugin whose connection is an api_key.
import { keyManifest } from "./manifest";
import { serveRaw } from "./raw-lib";

serveRaw({ spy: true, manifest: keyManifest });
