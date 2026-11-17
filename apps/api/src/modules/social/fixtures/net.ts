// SPDX-License-Identifier: AGPL-3.0-only
// A social network that exists only in tests. If core works with this one, core has no network ties.
import { definePlugin } from "@direx/plugin-sdk";

export function createTestNet() {
  const state = {
    identity: { accountId: "acct-1", accountLabel: "Ana", scopes: ["read"], targets: [{ id: "p1", name: "Page one", type: "page" }, { id: "p2", name: "Page two", type: "page" }, { id: "p3", name: "Page three", type: "page" }] } as unknown,
    health: { ok: true } as unknown,
    throwOnHealth: false,
    healthCalls: 0,
    limit: 100,
    published: [] as { spec: { text: string; followUps: string[]; target: string; links: boolean }; key: string }[],
    /** What the next publish does, then "sent" again. */
    next: "sent" as "sent" | "drop" | "rate_limit" | "token_rejected" | "follow_up_drops" | "follow_up_fails",
  };
  const plugin = definePlugin({
    manifest: {
      id: "com.example.testnet",
      apiVersion: 1,
      version: "1.0.0",
      minHostVersion: "0.1.0",
      trust: "first_party",
      connections: [{ key: "testnet", auth: "oauth2" }],
      egress: { hosts: [] },
      capabilities: [
        { kind: "query", name: "social.identity", connection: "testnet" },
        { kind: "query", name: "social.health", connection: "testnet" },
        { kind: "effect", name: "social.publish", connection: "testnet", dedupe: "blind", risk: "medium", reachesPerson: false },
      ],
    },
    effects: {
      "social.publish": {
        prepare: async (input) => {
          const i = input as { text: string; followUps: string[]; target: string; links: boolean };
          if (i.text.length > state.limit) throw new Error(`${i.text.length} of ${state.limit} characters`);
          const text = i.links ? i.text : i.text.replace(/https?:\/\/\S+/g, "").trim();
          return { spec: { ...i, text }, preview: text, count: { used: text.length, limit: state.limit } };
        },
        execute: async (spec, ctx) => {
          const next = state.next;
          state.next = "sent";
          if (next === "drop") throw new Error("connection dropped");
          if (next === "rate_limit") return { kind: "refused", permanent: false, retryable: true, detail: "slow down", providerLimit: "sending_limit" };
          if (next === "token_rejected") return { kind: "refused", permanent: false, retryable: true, detail: "token rejected", credentialRejected: true };
          state.published.push({ spec: spec as never, key: ctx.idempotencyKey });
          const followUps = (spec as { followUps: string[] }).followUps;
          return {
            kind: "sent",
            url: `https://net.example/${state.published.length}`,
            ...(followUps.length && { followUps: followUps.map(() => ({ status: next === "follow_up_drops" ? ("uncertain" as const) : next === "follow_up_fails" ? ("failed" as const) : ("posted" as const) })) }),
          };
        },
      },
    },
    queries: {
      "social.identity": async () => state.identity,
      "social.health": async () => {
        state.healthCalls++;
        if (state.throwOnHealth) throw new Error("the network is down");
        return state.health;
      },
    },
  });
  return { plugin, state };
}
