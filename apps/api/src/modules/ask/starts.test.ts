// SPDX-License-Identifier: AGPL-3.0-only
// Ask's prompt names each start with a fixed line, so its eval stays valid. Every owning module's
// start must be one of those ids with that same line, and all seven must have an owner.
import type { PgBoss } from "pg-boss";
import { expect, test } from "vitest";
import { brandAskStarts } from "../agents/index";
import { clipAskStarts } from "../clips/index";
import { planAskStarts } from "../plans/index";
import { prospectingAskStarts } from "../prospecting/index";
import { seoAskStarts } from "../seo/index";
import { START_SAYS } from "./index";

const unused = () => {
  throw new Error("not called");
};

test("every owner's start is one of Ask's fixed ids, with the same line, and each id has exactly one owner", () => {
  const owned = [
    ...planAskStarts({ plans: unused, runs: { strategy: unused, plan: unused }, report: unused }),
    ...brandAskStarts(unused),
    ...prospectingAskStarts({ boss: {} as PgBoss, terms: unused, strategy: unused, report: unused }),
    ...seoAskStarts({ briefs: unused, report: unused }),
    ...clipAskStarts({ clips: unused, media: unused }),
  ];
  expect(Object.fromEntries(owned.map((s) => [s.id, s.says]))).toEqual(START_SAYS);
  expect(owned).toHaveLength(Object.keys(START_SAYS).length);
});
