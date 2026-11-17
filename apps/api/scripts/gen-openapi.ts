// SPDX-License-Identifier: AGPL-3.0-only
// Writes the OpenAPI document the web client is generated from.
import { app, openApiConfig } from "../src/main";

await Bun.write(`${import.meta.dir}/../openapi.json`, `${JSON.stringify(app.getOpenAPI31Document(openApiConfig), null, 2)}\n`);
