// SPDX-License-Identifier: AGPL-3.0-only
import { builtinRules } from "eslint/use-at-your-own-risk";
import tseslint from "typescript-eslint";

// Core rules re-registered with a rule name prefixed to every message. max-lines is
// registered twice because one rule can carry only one severity per file.
const withName = (name, label) => {
  const rule = builtinRules.get(name);
  const messages = Object.fromEntries(Object.entries(rule.meta.messages).map(([k, m]) => [k, `${label}: ${m}`]));
  return { ...rule, meta: { ...rule.meta, messages } };
};
const dx = {
  rules: {
    "max-lines-warn": withName("max-lines", "file-too-long (split files over 800 lines)"),
    "max-lines-error": withName("max-lines", "file-too-long (CI fails over 1,500 lines)"),
    "no-raw-db-imports": withName("no-restricted-imports", "raw-db-import"),
  },
};

const rawDriver =
  // Every drizzle-orm entry point except the root and pg-core is a driver or driver tool.
  "^(pg|pg-pool|postgres)(/.*)?$|^drizzle-orm/(?!pg-core(/|$)).+";

// A cast to an object type (`as { ... }`, alone or in a union) of what a plugin hands core: an effect's
// spec, a query's answer or an event's data. The catalogue entry types each one once (ADR 0028 rule 001).
// Syntactic, as no-restricted-syntax has no types: it knows the value by its name, so it misses one
// renamed first (`const s = row.spec`), an Item's `content` or `payload`, and a cast to a named type.
const objectCast = "TSAsExpression[typeAnnotation.type=/^TS(TypeLiteral|UnionType)$/]";
const pluginCastMessage = "plugin-cast: read a plugin's spec, answer or event data through its catalogue entry (storedSpec, touchOf, a typed query), not a cast.";
const pluginCasts = [
  `${objectCast}[expression.type='Identifier'][expression.name='spec']`,
  `${objectCast}[expression.type='MemberExpression'][expression.property.name='spec']`,
  `${objectCast}[expression.type='LogicalExpression'][expression.left.property.name='spec']`,
  `${objectCast}[expression.type='AwaitExpression'][expression.argument.callee.property.name=/^(query|queryTyped)$/]`,
  `${objectCast}[expression.type='AwaitExpression'][expression.argument.callee.name=/^(query|queryTyped)$/]`,
  `${objectCast}[expression.type='MemberExpression'][expression.property.name='data'][expression.object.name=/^(e|ev|event)$/]`,
  `${objectCast}[expression.type='MemberExpression'][expression.property.name='data'][expression.object.property.name='event']`,
].map((selector) => ({ selector, message: pluginCastMessage }));
// A plugin failure's reason, status, wait and plan are fields on CallFailed; its message is for logs
// and display only, so core never runs a pattern over one (ADR 0028 rule 002).
const failureMessage = "read a failure's typed fields (failureOf, CallFailed.reason) instead of matching its message.";
const coreRules = [
  { selector: "CallExpression[callee.property.name=/^(test|exec)$/][arguments.0.property.name='message']", message: failureMessage },
  { selector: "CallExpression[callee.object.property.name='message'][callee.property.name=/^(match|matchAll|search)$/]", message: failureMessage },
  ...pluginCasts,
];

const viMock = (arg) =>
  `CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|doMock)$/][${arg}=/^\\.\\.?\\//]`;
const viMockMessage =
  "relative-vi-mock: do not vi.mock a relative path; test the module through its index.ts or over HTTP against a real database.";

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "**/fixtures/**"] },
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { dx },
  },
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    ignores: ["**/*.d.ts", "**/generated/**", "apps/web/src/api/**"],
    rules: {
      "dx/max-lines-warn": ["warn", { max: 800 }],
      "dx/max-lines-error": ["error", { max: 1500 }],
    },
  },
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    ignores: ["packages/db/**", "apps/api/src/modules/*/adapters/**", "test/**"],
    rules: {
      "dx/no-raw-db-imports": [
        "error",
        {
          patterns: [
            {
              regex: rawDriver,
              message:
                "raw database drivers are only for packages/db and module adapters/; use the workspace transaction wrapper from @direx/db.",
            },
          ],
        },
      ],
    },
  },
  {
    // A plugin failure's reason, status, wait and plan are fields on CallFailed; its message is for
    // logs and display only, so core never runs a pattern over one (ADR 0028 rule 002). Nor does core
    // cast what a plugin hands it (rule 001).
    files: ["apps/api/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { "no-restricted-syntax": ["error", ...coreRules] },
  },
  {
    // The entry points and the composition root build every module in one function: no module-level
    // slot filled after start, and no port called optionally to skip work (ADR 0027 rules 001 and 003).
    // A later no-restricted-syntax replaces the one above, so core's rules are repeated here.
    files: ["apps/api/src/main.ts", "apps/api/src/worker.ts", "apps/api/src/compose/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...coreRules,
        ...["Program > VariableDeclaration[kind='let']", "Program > ExportNamedDeclaration > VariableDeclaration[kind='let']"].map((selector) => ({
          selector,
          message: "module-slot: build it inside compose or createApp, and pass it on; a module-level let is filled after start (ADR 0027 rule 001).",
        })),
        {
          // opts.media?.(), and opts.media?.send()
          selector:
            ":matches(CallExpression[optional=true][callee.type='MemberExpression'][callee.object.name='opts'], CallExpression[callee.optional=true][callee.object.type='MemberExpression'][callee.object.object.name='opts'])",
          message: "optional-port: make the port required, so composition fails when it is missing instead of the handler skipping its work (ADR 0027 rule 003).",
        },
      ],
    },
  },
  {
    files: ["**/*.{test,spec}.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: viMock("arguments.0.value"), message: viMockMessage },
        { selector: viMock("arguments.0.source.value"), message: viMockMessage },
      ],
    },
  },
];
