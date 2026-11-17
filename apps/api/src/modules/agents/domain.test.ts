// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { z } from "zod";
import { aggregateDigest, digestOf } from "./adapters/digest";
import { defineAgent } from "./definitions/define";
import { admit, DEFAULT_CAPS, nextUtcDay, retryWait } from "./domain/caps";
import { checkManifestCitation } from "./domain/citations";
import { canMove, hasEnded, isIncomplete, type RunStatus } from "./domain/states";
import { workState } from "./application/ask-start";

const ENDED: RunStatus[] = ["succeeded", "failed", "cancelled", "timed_out", "step_capped", "cost_capped", "refused", "expired"];
const ALL: RunStatus[] = ["queued", "running", "waiting", ...ENDED];

test("a run that has ended never leaves its state", () => {
  for (const from of ENDED) {
    expect(hasEnded(from)).toBe(true);
    for (const to of ALL) expect(canMove(from, to)).toBe(false);
  }
});

test("live states move only as allowed", () => {
  expect(canMove("queued", "running")).toBe(true);
  expect(canMove("queued", "succeeded")).toBe(false);
  expect(canMove("waiting", "queued")).toBe(true);
  expect(canMove("waiting", "running")).toBe(false);
  expect(canMove("running", "running")).toBe(false);
  expect(hasEnded("waiting")).toBe(false);
});

test("the done line calls a run done only when it succeeded, and every other end a failure but a cancel", () => {
  expect(ALL.filter((s) => workState(s) === "done")).toEqual(["succeeded"]);
  expect(ALL.filter((s) => workState(s) === "cancelled")).toEqual(["cancelled"]);
  expect(ALL.filter((s) => workState(s) === "running")).toEqual(["queued", "running", "waiting"]);
  expect(ALL.filter((s) => workState(s) === "failed")).toEqual(["failed", "timed_out", "step_capped", "cost_capped", "refused", "expired"]);
});

test("only a run that finished counts as complete", () => {
  expect(isIncomplete("succeeded")).toBe(false);
  expect(isIncomplete("step_capped")).toBe(true);
  expect(isIncomplete("running")).toBe(false);
});

test("admission starts under the caps, queues on a full slot, and waits on a spent day", () => {
  const free = { agentRunning: 0, workspaceRunning: 0, agentToday: 0, workspaceToday: 0 };
  expect(admit(free, DEFAULT_CAPS)).toBe("start");
  expect(admit({ ...free, agentRunning: 1, workspaceRunning: 4, agentToday: 99, workspaceToday: 299 }, DEFAULT_CAPS)).toBe("start");
  expect(admit({ ...free, agentRunning: 2 }, DEFAULT_CAPS)).toBe("stay_queued");
  expect(admit({ ...free, workspaceRunning: 5 }, DEFAULT_CAPS)).toBe("stay_queued");
  expect(admit({ ...free, agentToday: 100 }, DEFAULT_CAPS)).toBe("daily_cap");
  expect(admit({ ...free, workspaceToday: 300 }, DEFAULT_CAPS)).toBe("daily_cap");
  expect(admit({ ...free, agentRunning: 2, agentToday: 100 }, DEFAULT_CAPS)).toBe("daily_cap");
});

test("the day turns at UTC midnight, across a month end", () => {
  expect(nextUtcDay(new Date("2026-10-31T23:59:59Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  expect(nextUtcDay(new Date("2026-10-30T00:00:00Z")).toISOString()).toBe("2026-10-31T00:00:00.000Z");
});

test("only passing failures retry, at most twice, honouring the provider's time", () => {
  const at = new Date("2026-10-30T12:00:00Z");
  expect(retryWait("transient_upstream", 0, at)).toBe(30_000);
  expect(retryWait("provider_quota", 1, at)).toBe(60_000);
  expect(retryWait("transient_upstream", 2, at)).toBeNull();
  expect(retryWait("bad_request", 0, at)).toBeNull();
  expect(retryWait("provider_quota", 0, at, new Date(at.getTime() + 5_000))).toBe(5_000);
  expect(retryWait("provider_quota", 0, at, new Date(at.getTime() - 5_000))).toBe(0);
});

test("a digest changes with the words, and the aggregate with the order", () => {
  expect(digestOf("a")).not.toBe(digestOf("b"));
  const [a, b] = [{ digest: digestOf("a") }, { digest: digestOf("b") }];
  expect(aggregateDigest([a, b])).toBe(aggregateDigest([a, b]));
  expect(aggregateDigest([a, b])).not.toBe(aggregateDigest([b, a]));
});

test("a citation is ok only when the run read it and it is still current", () => {
  const manifest = [{ kind: "fact", refId: "f1", version: "2" }, { kind: "web_page", refId: "f9", version: "1" }];
  const current = (id: string) => ({ f1: 2, f2: 1, f9: 1 })[id];
  expect(checkManifestCitation("f1@2", manifest, current)).toBe("ok");
  expect(checkManifestCitation("f1@1", manifest, current)).toBe("outside_manifest");
  expect(checkManifestCitation("f2@1", manifest, current)).toBe("outside_manifest");
  expect(checkManifestCitation("f9@1", manifest, current)).toBe("outside_manifest");
  expect(checkManifestCitation("f1@2", manifest, () => 3)).toBe("stale");
  expect(checkManifestCitation("f1@2", manifest, () => undefined)).toBe("stale");
  for (const bad of ["f1", "f1@", "@2", "f1@0", "f1@2x"]) expect(checkManifestCitation(bad, manifest, current)).toBe("malformed");
});

test("a definition must be bounded and can name only read tools", () => {
  const d = { id: "x", version: 1, promptRevision: "r", prompt: "p", purposes: ["p"], tools: [], deadlineMs: 1, stepCap: 1, output: z.object({}), context: [], proposals: () => [] };
  expect(defineAgent(d).id).toBe("x");
  expect(() => defineAgent({ ...d, stepCap: 0 })).toThrow(/step cap/);
  expect(() => defineAgent({ ...d, deadlineMs: 0 })).toThrow(/deadline/);
  expect(() => defineAgent({ ...d, tools: ["send_email"] as never })).toThrow(/read tools/);
});

test("a definition names a plugin read only as a catalogue agent query with its version", () => {
  const d = { id: "x", version: 1, promptRevision: "r", prompt: "p", purposes: ["p"], tools: [], deadlineMs: 1, stepCap: 1, output: z.object({}), context: [], proposals: () => [] };
  expect(defineAgent({ ...d, tools: ["fetch_page", "mail.from@1"] }).tools).toEqual(["fetch_page", "mail.from@1"]);
  for (const t of ["mail.from", "mail.from@2", "mailbox.profile@1", "com.trydirex.gmail/mail.from@1"]) {
    expect(() => defineAgent({ ...d, tools: [t] as never }), t).toThrow(/agent queries from the catalogue/);
  }
});
