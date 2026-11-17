// SPDX-License-Identifier: AGPL-3.0-only
const path = require("node:path");

const MODULES = "^apps/api/src/modules/";
/** Test support: shared fixtures and test-only helpers. Tests may reach them across modules; nothing else may. */
const TEST_SUPPORT = ["(^|/)fixtures/", "/test-[^/]+\\.ts$", `${MODULES}credentials/fake-provider\\.ts$`];
const TEST_CODE = ["\\.test\\.tsx?$", ...TEST_SUPPORT, "^scripts/test/"];
/** A module's eval cases and scoring: a second entry point, for tests and scripts only. */
const EVALS = `${MODULES}[^/]+/evals\\.ts$`;
const DB = [
  "(^|/)packages/db/",
  "(^|/)node_modules/(drizzle-orm|pg|postgres)/",
  "^(drizzle-orm|pg|postgres|@direx/db)(/|$)",
];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "module-entry-only",
      comment: "Code outside the modules imports a module only through its index.ts.",
      severity: "error",
      from: { pathNot: MODULES },
      to: { path: `${MODULES}[^/]+/`, pathNot: [`${MODULES}[^/]+/index\\.ts$`, `${MODULES}credentials/system-secrets\\.ts$`, EVALS, ...TEST_SUPPORT] },
    },
    {
      name: "module-entry-only-cross-module",
      comment: "Another module is imported only through its index.ts; files in the same module may import each other.",
      severity: "error",
      from: { path: `${MODULES}([^/]+)/` },
      to: {
        path: `${MODULES}[^/]+/`,
        pathNot: [`${MODULES}[^/]+/index\\.ts$`, `${MODULES}$1/`, `${MODULES}credentials/use-secret\\.ts$`, `${MODULES}credentials/system-secrets\\.ts$`, EVALS, ...TEST_SUPPORT],
      },
    },
    {
      name: "no-test-support-in-production",
      comment: "Fixtures and test-only helpers are for tests; production code never imports them.",
      severity: "error",
      from: { pathNot: TEST_CODE },
      to: { path: TEST_SUPPORT },
    },
    {
      name: "evals-only-in-tests",
      comment: "A module's evals.ts holds eval cases and scoring; the product never imports them.",
      severity: "error",
      from: { pathNot: TEST_CODE },
      to: { path: EVALS },
    },
    {
      name: "use-secret-only-in-consumers",
      comment: "Only plugins, models and mcp-client may hold a credential's value through useSecret.",
      severity: "error",
      from: { pathNot: `${MODULES}(credentials|plugins|models|mcp-client)/` },
      to: { path: `${MODULES}credentials/use-secret\\.ts$` },
    },
    {
      name: "system-secrets-only-in-startup-and-models",
      comment: "The deployment's secrets are for startup, the operator's command and models.",
      severity: "error",
      from: { pathNot: [`${MODULES}(credentials|models)/`, "^apps/api/src/(startup|secrets)\\.ts$"] },
      to: { path: `${MODULES}credentials/system-secrets\\.ts$` },
    },
    {
      name: "model-sdk-only-in-models",
      comment: "Only the models module may import the AI SDK or a model provider SDK.",
      severity: "error",
      from: { pathNot: `${MODULES}models/` },
      to: { path: ["node_modules/(ai|@ai-sdk|@openrouter/ai-sdk-provider|@anthropic-ai/sdk|openai)/", "^(ai|@ai-sdk/[^/]+|@openrouter/ai-sdk-provider|@anthropic-ai/sdk|openai)(/|$)"] },
    },
    {
      name: "mcp-sdk-only-in-door-mcp",
      comment: "Only the door's MCP face may import the MCP SDK, so the protocol stays at the edge (door-mcp spec).",
      severity: "error",
      from: { pathNot: [`${MODULES}door/mcp\\.ts$`, ...TEST_CODE] },
      to: { path: ["node_modules/@modelcontextprotocol/sdk/", "^@modelcontextprotocol/sdk(/|$)"] },
    },
    {
      name: "agents-own-tables-only",
      comment: "agents writes only its own tables; anything else goes through the owning module's entry point.",
      severity: "error",
      from: { path: `${MODULES}agents/` },
      to: { path: ["(^|/)packages/db/src/(schema|auth-schema)\\.ts$", "^@direx/db/(schema|auth)$"] },
    },
    {
      name: "db-only-in-adapters",
      comment: "Only a module's adapters/ may import @direx/db, drizzle-orm, pg or postgres.",
      severity: "error",
      from: { path: "^apps/api/src/", pathNot: [`${MODULES}[^/]+/adapters/`, ...TEST_SUPPORT] },
      to: { path: DB },
    },
    {
      name: "auth-db-only-in-identity",
      comment: "Only the identity module's adapters/ may import @direx/db/auth.",
      severity: "error",
      from: { pathNot: ["^apps/api/src/modules/identity/adapters/", "^packages/db/", ...TEST_SUPPORT] },
      to: { path: ["(^|/)packages/db/src/auth\\.ts$", "^@direx/db/auth$"] },
    },
    {
      name: "with-user-only-in-identity",
      comment: "Only the identity module's adapters/ may import @direx/db/user.",
      severity: "error",
      from: { pathNot: ["^apps/api/src/modules/identity/adapters/", "^packages/db/"] },
      to: { path: ["(^|/)packages/db/src/user\\.ts$", "^@direx/db/user$"] },
    },
    {
      name: "no-extensions-in-modules",
      comment:
        "A core module takes no contract or plugin data from @direx/extensions: shapes come from the SDK catalogue, and the composition roots (main.ts, worker.ts) pass in the rest (ADR 0028 rule 001).",
      severity: "error",
      from: { path: MODULES, pathNot: TEST_CODE },
      to: { path: ["(^|/)packages/extensions/", "^@direx/extensions(/|$)"] },
    },
    {
      name: "plugin-sdk-stands-alone",
      comment: "The MIT plugin SDK imports only itself, zod and Node's built-ins, never the AGPL code beside it (ADR 0002).",
      severity: "error",
      from: { path: "(^|/)packages/plugin-sdk/src/" },
      to: { pathNot: ["(^|/)packages/plugin-sdk/src/", "(^|/)node_modules/zod/", "^zod(/|$)"], dependencyTypesNot: ["core"] },
    },
    {
      name: "domain-is-pure",
      comment: "A module's domain/ imports nothing outside its own domain/ folder: no I/O, no packages.",
      severity: "error",
      from: { path: `${MODULES}([^/]+)/domain/` },
      to: { pathNot: `${MODULES}$1/domain/` },
    },
    {
      name: "no-cycles",
      comment: "Import cycles fail the build.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-relative-dynamic-import",
      comment:
        "A relative dynamic import() hides a cycle; import statically instead. The web app's route file alone may load screens lazily, so the first page stays within the page-speed budget.",
      severity: "error",
      from: { pathNot: "^apps/web/src/router\\.tsx$" },
      to: { dynamic: true, dependencyTypes: ["local"] },
    },
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules/" },
    exclude: { path: "^(apps|packages)/[^/]+/dist/" },
    tsConfig: { fileName: path.join(__dirname, "tsconfig.json") },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["bun", "import", "require", "node", "default", "types"] },
  },
};
