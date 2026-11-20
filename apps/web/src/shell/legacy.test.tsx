// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { legacyPath } from "./legacy";

const W = "11111111-1111-1111-1111-111111111111";

test.each([
  [`?workspace=${W}`, `/w/${W}`],
  [`?workspace=${W}&page=calendar`, `/w/${W}/calendar`],
  [`?workspace=${W}&page=campaigns`, `/w/${W}/campaigns`],
  [`?workspace=${W}&page=campaigns&campaign=c9`, `/w/${W}/campaigns/c9`],
  [`?workspace=${W}&page=campaigns&campaign=c9&tab=drafts`, `/w/${W}/campaigns/c9?tab=drafts`],
  [`?workspace=${W}&page=campaigns&plan=p1&run=r1`, `/w/${W}/plans/p1?run=r1`],
  [`?workspace=${W}&page=campaigns&plan=p1&notice=busy`, `/w/${W}/plans/p1?notice=busy`],
  [`?workspace=${W}&page=rules&campaign=c&step=first`, `/w/${W}/settings/rules?campaign=c&step=first`],
  [`?workspace=${W}&page=rules&campaign=c&step=a%20b&mode=agent_written`, `/w/${W}/settings/rules?campaign=c&step=a+b&mode=agent_written`],
  [`?workspace=${W}&page=lessons`, `/w/${W}/brand/lessons`],
  [`?workspace=${W}&page=brand`, `/w/${W}/brand`],
  [`?workspace=${W}&page=models`, `/w/${W}/settings/models`],
  [`?workspace=${W}&page=credentials&connected=k1`, `/w/${W}/settings/credentials?connected=k1`],
  [`?workspace=${W}&page=social&connect_error=denied`, `/w/${W}/settings/social?connect_error=denied`],
  [`?workspace=${W}&page=social&connect_error=network_refused&connect_code=invalid_client`, `/w/${W}/settings/social?connect_error=network_refused&connect_code=invalid_client`],
  [`?workspace=${W}&page=members`, `/w/${W}/settings/members`],
  [`?workspace=${W}&page=prospecting`, `/w/${W}/people/find`],
  [`?workspace=${W}&page=prospecting&run=r2`, `/w/${W}/people/find/r2`],
  [`?workspace=${W}&page=cohorts`, `/w/${W}/people/cohorts`],
  [`?workspace=${W}&page=cohorts&cohort=h1`, `/w/${W}/people/cohorts/h1`],
  [`?workspace=${W}&page=cohorts&handover=x1`, `/w/${W}/people/handovers/x1`],
  [`?workspace=${W}&page=outreach`, `/w/${W}/people`],
  [`?workspace=${W}&page=newsletter`, `/w/${W}/newsletter`],
  [`?workspace=${W}&page=newsletter&issue=i1`, `/w/${W}/newsletter/i1`],
  [`?workspace=${W}&page=seo&connect_error=denied`, `/w/${W}/seo?connect_error=denied`],
  ["?reset=password&token=abc", "/reset-password?token=abc"],
  ["?new=org", "/new-org"],
])("%s goes to %s", (search, path) => {
  expect(legacyPath(search)).toBe(path);
});

test("the API's connect callback, which names no Workspace, lands in the first one", () => {
  expect(legacyPath("?page=credentials&connect_error=expired", W)).toBe(`/w/${W}/settings/credentials?connect_error=expired`);
  expect(legacyPath("?page=credentials&connect_error=expired")).toBeNull();
});

test("a search that isn't an old link is left alone", () => {
  expect(legacyPath("")).toBeNull();
  expect(legacyPath("?tab=drafts")).toBeNull();
});
