// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { fieldsIn, merge, missingFields, stepFields, unknownFields } from "./domain/merge";
import { checkDependency, checkOutputUrl, MAX_URL_LENGTH, sameIgnoringUtm, withUtm, type LinkedStep } from "./domain/step-links";

const step = (stepKey: string, type: string, dependsOnStepKey: string | null = null): LinkedStep => ({ stepKey, type, dependsOnStepKey });
const steps = [step("page", "manual"), step("launch-post", "post"), step("email-1", "email"), step("dm-1", "dm"), step("follow", "email", "page")];

test("a step may wait on a manual or post step in the same Campaign", () => {
  expect(checkDependency(steps, "email-1", "page")).toEqual({ ok: true });
  expect(checkDependency(steps, "email-1", "launch-post")).toEqual({ ok: true });
});

test("every refused dependency names its reason", () => {
  expect(checkDependency(steps, "page", "page")).toEqual({ ok: false, reason: "dependency_self" });
  expect(checkDependency(steps, "email-1", "missing")).toEqual({ ok: false, reason: "dependency_not_found" });
  expect(checkDependency(steps, "email-1", "dm-1")).toEqual({ ok: false, reason: "no_output" });
  expect(checkDependency(steps, "email-1", "follow")).toEqual({ ok: false, reason: "dependency_depth" });
});

test("dependencies are one level deep in both directions", () => {
  const chain = [step("page", "manual"), step("post", "post", "page"), step("email-1", "email")];
  expect(checkDependency(chain, "email-1", "post")).toEqual({ ok: false, reason: "dependency_depth" });
  expect(checkDependency(steps, "page", "launch-post")).toEqual({ ok: false, reason: "dependency_depth" });
});

test("an output URL must be https, without credentials, and at most 2,048 characters", () => {
  expect(checkOutputUrl("  https://acme.co/launch?ref=x  ")).toEqual({ ok: true, url: "https://acme.co/launch?ref=x" });
  for (const bad of ["", "http://acme.co", "javascript:alert(1)", "https://sam:pw@acme.co", "https://sam@acme.co", "not a url", `https://acme.co/${"a".repeat(MAX_URL_LENGTH)}`])
    expect(checkOutputUrl(bad)).toEqual({ ok: false, reason: "bad_url" });
});

test("UTM tags are added, other parameters kept, and existing utm_ ones replaced", () => {
  const tagged = new URL(withUtm("https://acme.co/launch?ref=x&utm_source=old&UTM_Medium=old", { medium: "email", campaign: "c1", content: "email-1" }));
  expect(tagged.searchParams.get("ref")).toBe("x");
  expect([...tagged.searchParams.keys()].filter((k) => k.toLowerCase().startsWith("utm_"))).toEqual(["utm_source", "utm_medium", "utm_campaign", "utm_content"]);
  expect(Object.fromEntries(tagged.searchParams)).toMatchObject({ utm_source: "direx", utm_medium: "email", utm_campaign: "c1", utm_content: "email-1" });
});

test("two URLs are the same page when only their utm_ parameters differ", () => {
  expect(sameIgnoringUtm("https://acme.co/launch?ref=x", "https://acme.co/launch?ref=x&utm_source=direx&utm_content=a")).toBe(true);
  expect(sameIgnoringUtm("https://acme.co/launch", "https://acme.co/other")).toBe(false);
  expect(sameIgnoringUtm("https://acme.co/launch", "not a url")).toBe(false);
});

test("a step output field is only known when its step is allowed", () => {
  const text = "See {{steps.page.url}} and {{steps.other.url}}, {{firstName}}";
  expect(stepFields(text)).toEqual(["page", "other"]);
  expect(unknownFields(text, ["page"])).toEqual(["steps.other.url"]);
  expect(unknownFields(text)).toEqual(["steps.page.url", "steps.other.url"]);
  expect(fieldsIn("{{ steps.page.url }}")).toEqual(["steps.page.url"]);
  expect(stepFields("{{steps.Page.url}} {{steps.page.title}}")).toEqual([]);
});

test("a step's URL fills once and is never read as a field itself", () => {
  const filled = merge("Hi {{firstName}}, see {{steps.page.url}}", { firstName: "Sam" }, { page: "https://acme.co/{{company}}" });
  expect(filled).toEqual({ ok: true, text: "Hi Sam, see https://acme.co/{{company}}" });
  expect(missingFields("{{steps.page.url}}", {}, {})).toEqual(["steps.page.url"]);
  expect(merge("{{steps.toString.url}}", {}, {})).toEqual({ ok: false, missing: ["steps.toString.url"] });
});
