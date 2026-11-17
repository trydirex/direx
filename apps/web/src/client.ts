// SPDX-License-Identifier: AGPL-3.0-only
import createClient from "openapi-fetch";
import type { paths } from "./api/schema";

// Typed from the generated OpenAPI paths; no hand-written URLs or response types.
export const api = createClient<paths>();
