// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { matchingRules, parseRules } from "./adr-rules";

const adr = (status: string) => `# 0099. Test

- **Status**: ${status}

\`\`\`adr-rules
id: DX-R-0099-001
rule: Plugins MUST do a thing.
applies_to: repositories/direx/{apps/api/src/modules/plugins,packages/plugin-sdk}/**
enforced_by: none
verify: none: test

id: DX-R-0099-002
rule: Retired.
applies_to: none
enforced_by: none
verify: none: retired
\`\`\`
`;

test("a rule matches through braces and **, and a retired rule never does", () => {
  const rules = parseRules("0099-test", adr("accepted"));
  expect(rules.map((r) => [r.id, r.status, r.verify])).toEqual([["DX-R-0099-001", "accepted", "none: test"]]);
  expect(matchingRules(rules, ["repositories/direx/packages/plugin-sdk/src/manifest.ts"]).map((r) => r.id)).toEqual(["DX-R-0099-001"]);
  expect(matchingRules(rules, ["repositories/direx/apps/web/src/main.tsx"])).toEqual([]);
});

test("the narrowest glob comes first", () => {
  const [rule] = parseRules("0099-test", adr("accepted"));
  const specific = { ...rule!, appliesTo: "repositories/direx/packages/plugin-sdk/**" };
  const broad = { ...rule!, id: "DX-R-0099-003", appliesTo: "repositories/direx/{apps,packages}/**" };
  expect(matchingRules([broad, specific], ["repositories/direx/packages/plugin-sdk/x.ts"]).map((r) => r.id)).toEqual(["DX-R-0099-001", "DX-R-0099-003"]);
});

test("a superseded ADR's rules are left out", () => {
  expect(matchingRules(parseRules("0099-test", adr("superseded by 0100")), ["repositories/direx/packages/plugin-sdk/x.ts"])).toEqual([]);
});
