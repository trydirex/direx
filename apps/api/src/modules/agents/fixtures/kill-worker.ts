// SPDX-License-Identifier: AGPL-3.0-only
// A real worker process for the SIGKILL test. After its first proposal reaches facts it records
// the Item in the MARKER file and never returns, so the test can kill it there.
import { appendFileSync } from "node:fs";
import { createBoss } from "../../../jobs/boss";
import { createFacts, factKinds } from "../../facts";
import { createItems } from "../../items";
import { createLedger, oneKey } from "../../ledger/index";
import { testKey } from "../../ledger/test-effects";
import { createModels, routesFor, type Models } from "../../models/index";
import { testKeys } from "../../models/fixtures/provider";
import { createAgents, factContext, factSink } from "../index";

const { MARKER: marker, PROVIDER_URL: providerUrl } = process.env;
if (!marker || !providerUrl) throw new Error("MARKER and PROVIDER_URL must be set");

const boss = createBoss();
await boss.start();
const items = createItems({ ledger: createLedger({ boss, signingKeys: oneKey(testKey), effects: {} }), kinds: factKinds() });
const facts = createFacts({ items: () => items });
const real = factSink(facts);
let models: Models;
const agents = createAgents({
  boss,
  deployment: "self_host",
  routes: routesFor("self_host"),
  models: () => models,
  sinks: {
    fact_proposal: async (ws, p, c) => {
      const made = await real(ws, p, c);
      appendFileSync(marker, made.ok ? made.itemId! : made.code);
      return new Promise(() => {});
    },
  },
  addWarning: items.addWarning,
  context: factContext(facts),
  notify: async () => {},
  fetchPage: async (_b, url) => ({ ok: true, url, text: "We sell audits.", truncated: false }),
});
models = createModels({ deployment: "self_host", keys: testKeys("sk-test"), baseURLs: { anthropic: providerUrl }, runGate: agents.runGate });
await agents.work();
