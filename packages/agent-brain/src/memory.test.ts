import assert from "node:assert/strict";
import test from "node:test";

import type { LifecycleEvent } from "@agent-hooks/sdk";
import {
  AgentBrain,
  type Experience,
  type ExperienceQuery,
  type ExperienceStore,
} from "./memory.js";

class TestStore implements ExperienceStore {
  readonly records: Experience[] = [];

  async append(experience: Experience): Promise<void> {
    this.records.push(experience);
  }

  async query(query: ExperienceQuery): Promise<Experience[]> {
    const records = query.verifiedOnly
      ? this.records.filter((record) => record.evidence.channel === "chain")
      : this.records;
    return records.slice(0, query.limit ?? 20);
  }
}

function event(): LifecycleEvent {
  return {
    kind: "beforeBorrow",
    adapter: "solend",
    position: {
      owner: "owner",
      collateralMint: "collateral",
      debtMint: "debt",
      collateralAmount: 100,
      debtAmount: 50,
      ltvBps: 5_000,
      liquidationThresholdBps: 8_000,
    },
    market: {
      slot: 10,
      timestamp: 1_700_000_000,
      realisedVolBps: 400,
      utilisationBps: 5_000,
      oraclePoints: [],
    },
    payload: [],
  };
}

const feedback = {
  compositionId: "sol-usdc-v1",
  hookProgramIds: ["hook-a", "hook-a"],
  accepted: true,
  outcome: "executed" as const,
  reward: 0.7,
  rewardUnit: "normalized_0_1",
};

test("observe snapshots trace/event inputs and labels missing provenance unverified", async () => {
  const store = new TestStore();
  const brain = new AgentBrain(store);
  const sourceEvent = event();
  const trace = [{ hookId: "hook-a", decision: "accepted" as "accepted" | "rejected" }];
  const experience = await brain.observe({
    event: sourceEvent,
    feedback,
    tags: ["solana", " solana ", ""],
    trace,
  });

  sourceEvent.market.slot = 99;
  trace[0]!.decision = "rejected";
  assert.equal(experience.schemaVersion, 1);
  assert.equal(experience.event.market.slot, 10);
  assert.equal(experience.trace[0]?.decision, "accepted");
  assert.deepEqual(experience.tags, ["solana"]);
  assert.deepEqual(experience.feedback.hookProgramIds, ["hook-a"]);
  assert.deepEqual(experience.evidence, { channel: "unknown", status: "unverified" });
  assert.equal(Object.isFrozen(experience.event.market), true);
});

test("verified-only recall filters to caller-marked confirmed chain evidence", async () => {
  const store = new TestStore();
  const brain = new AgentBrain(store);
  await brain.observe({ event: event(), feedback, tags: [] });
  const confirmed = await brain.observe({
    event: event(),
    feedback,
    tags: [],
    evidence: {
      channel: "chain",
      status: "confirmed",
      network: "solana-mainnet",
      transactionId: "signature-1",
      slot: 123,
    },
  });

  const records = await brain.recall({ verifiedOnly: true, limit: 5 });
  assert.deepEqual(records.map((record) => record.id), [confirmed.id]);
});

test("rejects malformed rewards and unidentifiable confirmed evidence", async () => {
  const brain = new AgentBrain(new TestStore());
  await assert.rejects(
    brain.observe({ event: event(), feedback: { ...feedback, reward: Number.NaN }, tags: [] }),
    /finite number/,
  );
  await assert.rejects(
    brain.observe({
      event: event(),
      feedback,
      tags: [],
      evidence: { channel: "chain", status: "finalized" },
    }),
    /must include network, transactionId, and slot or blockHeight/,
  );
  await assert.rejects(
    brain.observe({
      event: event(),
      feedback: { ...feedback, rewardUnit: "" },
      tags: [],
    }),
    /rewardUnit is required/,
  );
});
