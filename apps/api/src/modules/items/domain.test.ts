// SPDX-License-Identifier: AGPL-3.0-only
import { expect, expectTypeOf, test } from "vitest";
import type { State } from "../ledger/index";
import { FALLBACK_REASON, reasonLabel } from "./domain/reasons";
import { canMove, detailsStale, isClean, visibleState, type LedgerState } from "./domain/state";

test("a rule's hold says what it needs reviewed", () => {
  expect(reasonLabel("rule_needs_review", "template changed")).toBe("rule needs review: template changed");
});

test("a relationship hold says why, and never shows a raw code", () => {
  expect(reasonLabel("in_conversation", "Skipped on approval")).toBe("you're already talking to this Person: Skipped on approval");
  expect(reasonLabel("may_be_talking", "sent_mail")).toBe("you may already be talking to this Person: you wrote to them in the last 90 days");
  expect(reasonLabel("may_be_talking", "company:acme.com")).toBe("you may already be talking to this Person: you're talking to someone else at acme.com");
  expect(reasonLabel("may_be_talking", "something_new")).toBe("you may already be talking to this Person");
});

test("the state list here is exactly the ledger's", () => {
  expectTypeOf<LedgerState>().toEqualTypeOf<State>();
});

test("claimed and dispatching show as Scheduled, and everything else as itself", () => {
  expect(visibleState("claimed")).toBe("scheduled");
  expect(visibleState("dispatching")).toBe("scheduled");
  for (const s of ["draft", "needs_approval", "scheduled", "sent", "held", "blocked", "cancelled", "applied"] as const) {
    expect(visibleState(s)).toBe(s);
  }
});

test("clean means no warnings on the current draft", () => {
  expect(isClean([])).toBe(true);
  expect(isClean(["a claim has no source"])).toBe(false);
  expect(isClean([], detailsStale(1, 2))).toBe(false);
  expect(isClean([], detailsStale(2, 2))).toBe(true);
});

test("an Item can move until its effect may have begun", () => {
  for (const s of ["draft", "needs_approval", "scheduled", "claimed"] as const) expect(canMove(s, null)).toBe(true);
  expect(canMove("held", "cap")).toBe(true);
  expect(canMove("held", "outcome_unknown")).toBe(false);
  for (const s of ["dispatching", "sent", "blocked", "cancelled", "applied"] as const) expect(canMove(s, null)).toBe(false);
});

test("every reason in use today has words, and none of them say failed", () => {
  const codes = [
    "outcome_unknown",
    "provider_rejected",
    "approval_invalid",
    "approval_expired",
    "snapshot_changed",
    "cap",
    "approver_permission_lost",
    "credential_unavailable",
    "provider_refused_permanently",
    "touch_undeclared",
  ];
  for (const code of codes) {
    expect(reasonLabel(code)).not.toBe(FALLBACK_REASON);
    expect(reasonLabel(code)).not.toMatch(/fail/i);
  }
});

test("a provider's message follows its refusal, and an unworded reason shows the fallback", () => {
  expect(reasonLabel("provider_rejected", "mailbox over quota")).toBe("provider rejected: mailbox over quota");
  expect(reasonLabel("cap", "ignored")).toBe("frequency cap reached");
  expect(reasonLabel("new_reason")).toBe(FALLBACK_REASON);
});
