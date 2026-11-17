// SPDX-License-Identifier: AGPL-3.0-only
// The free checks before a paid one, over a stand-in resolver so no test depends on real DNS.
import { expect, test } from "vitest";
import { beforePaidCheck } from "./adapters/mail-records";

const dnsError = (code: string) => Object.assign(new Error(`query failed ${code}`), { code });
const answers: Record<string, { exchange: string }[] | Error> = {
  "acme.com": [{ exchange: "mx1.acme.com" }],
  "gone.example": dnsError("ENOTFOUND"),
  "nomx.example": dnsError("ENODATA"),
  "nullmx.example": [{ exchange: "" }],
  "flaky.example": dnsError("ETIMEOUT"),
};
const asked: string[] = [];
const resolve = async (domain: string) => {
  asked.push(domain);
  const a = answers[domain];
  if (!a) throw dnsError("ENOTFOUND");
  if (a instanceof Error) throw a;
  return a;
};

test.each([
  ["ana@acme.com", null],
  ["Ana@ACME.com", null],
  ["ana@gone.example", "invalid"],
  ["ana@nomx.example", "invalid"],
  ["ana@nullmx.example", "invalid"],
  ["ana@flaky.example", "unknown"],
])("%s gives %s", async (email, want) => {
  expect(await beforePaidCheck(email, resolve)).toBe(want);
});

test("a malformed address is invalid without a DNS lookup", async () => {
  asked.length = 0;
  for (const email of ["ana", "ana@", "@acme.com", "ana acme@acme.com", "ana@@acme.com"]) expect(await beforePaidCheck(email, resolve)).toBe("invalid");
  expect(asked).toEqual([]);
});
