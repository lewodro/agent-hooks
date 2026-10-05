import assert from "node:assert/strict";
import test from "node:test";

import type { LifecycleEvent } from "@agent-hooks/adapter-core";
import {
  AgentBrain,
  ExperienceIdConflictError,
  ExperienceNotificationError,
  MemoryExperienceStore,
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
      slot: 10n,
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

  sourceEvent.market.slot = 99n;
  trace[0]!.decision = "rejected";
  assert.equal(experience.schemaVersion, 1);
  assert.equal(experience.event.market.slot, 10n);
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

test("live subscribers receive durable records and can opt into verified-only feedback", async () => {
  const store = new TestStore();
  const brain = new AgentBrain(store);
  const allEvents: string[] = [];
  const confirmedEvents: string[] = [];
  const unsubscribeAll = brain.subscribe((record) => {
    assert.ok(store.records.some((stored) => stored.id === record.id));
    allEvents.push(record.id);
  });
  const unsubscribeVerified = brain.subscribe(
    (record) => {
      confirmedEvents.push(record.id);
    },
    { verifiedOnly: true },
  );

  const simulated = await brain.observe({ event: event(), feedback, tags: [] });
  const confirmed = await brain.observe({
    event: event(),
    feedback,
    tags: [],
    evidence: {
      channel: "chain",
      status: "finalized",
      network: "solana-mainnet",
      transactionId: "signature-2",
      slot: 124,
    },
  });
  unsubscribeAll();
  unsubscribeVerified();

  assert.deepEqual(allEvents, [simulated.id, confirmed.id]);
  assert.deepEqual(confirmedEvents, [confirmed.id]);
});

test("subscriber failures report an error after the experience is stored", async () => {
  const store = new TestStore();
  const brain = new AgentBrain(store);
  brain.subscribe(() => {
    throw new Error("planner queue offline");
  });

  await assert.rejects(
    brain.observe({ id: "retry-me", event: event(), feedback, tags: [] }),
    (error: unknown) =>
      error instanceof ExperienceNotificationError &&
      error.experienceId === "retry-me" &&
      store.records.some((record) => record.id === "retry-me"),
  );
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

test("memory store is idempotent, immutable, filtered, and bounded", async () => {
  const store = new MemoryExperienceStore(2);
  const brain = new AgentBrain(store);
  const first = await brain.observe({
    id: "first",
    observedAt: "2026-01-01T00:00:00.000Z",
    event: event(),
    feedback,
    tags: [],
    evidence: {
      channel: "chain",
      status: "confirmed",
      network: "solana-devnet",
      transactionId: "sig-first",
      slot: 10,
    },
  });

  await store.append(first);
  assert.equal((await brain.recall()).length, 1, "appending the same record is idempotent");
  await assert.rejects(
    brain.observe({
      id: "first",
      observedAt: first.observedAt,
      event: event(),
      feedback: { ...feedback, reward: 0.1 },
      tags: [],
      evidence: first.evidence,
      trace: first.trace,
    }),
    ExperienceIdConflictError,
  );

  await brain.observe({
    id: "second",
    observedAt: "2026-01-02T00:00:00.000Z",
    event: event(),
    feedback: { ...feedback, compositionId: "other-composition" },
    tags: [],
  });
  await brain.observe({
    id: "third",
    observedAt: "2026-01-03T00:00:00.000Z",
    event: event(),
    feedback,
    tags: [],
  });

  assert.deepEqual((await brain.recall()).map(({ id }) => id), ["third", "second"]);
  assert.deepEqual(
    (await brain.recall({ compositionId: "sol-usdc-v1" })).map(({ id }) => id),
    ["third"],
  );
  assert.deepEqual((await brain.recall({ verifiedOnly: true })).map(({ id }) => id), []);
  assert.equal(Object.isFrozen((await brain.recall())[0]), true);
});

test("memory store rejects unsafe capacities", () => {
  assert.throws(() => new MemoryExperienceStore(0), /maxRecords/);
  assert.throws(() => new MemoryExperienceStore(Number.MAX_SAFE_INTEGER + 1), /maxRecords/);
});

test("memory store validates records even when bypassing AgentBrain", async () => {
  const store = new MemoryExperienceStore();
  const valid = await new AgentBrain(new MemoryExperienceStore()).observe({ event: event(), feedback, tags: [] });
  const malformed = structuredClone(valid);
  malformed.event.payload = new Array(257).fill(0);
  await assert.rejects(store.append(malformed), /event payload/);
  assert.deepEqual(await store.query({}), [], "invalid records are never retained");
});

test("brain rejects oracle observations outside deterministic runtime bounds", async () => {
  const brain = new AgentBrain(new TestStore());
  const invalid = event();
  invalid.market.oraclePoints = [{
    mint: "oracle-a",
    priceE8: 10_000n,
    confidenceE8: 1_001n,
    slot: 9n,
  }];
  await assert.rejects(brain.observe({ event: invalid, feedback, tags: [] }), /confidence exceeds 1000 bps/);

  invalid.market.oraclePoints.push({
    mint: "oracle-a",
    priceE8: 10_000n,
    confidenceE8: 1n,
    slot: 9n,
  });
  invalid.market.oraclePoints[0]!.confidenceE8 = 1n;
  await assert.rejects(brain.observe({ event: invalid, feedback, tags: [] }), /is duplicated/);
});

test("memory feed supports ordered resume cursors and bounded pages", async () => {
  const store = new MemoryExperienceStore();
  const brain = new AgentBrain(store);
  await brain.observe({ id: "feed-first", event: event(), feedback, tags: [], observedAt: "2026-10-05T00:00:00.000Z" });
  await brain.observe({ id: "feed-second", event: event(), feedback, tags: [], observedAt: "2026-01-01T00:00:00.000Z" });
  await brain.observe({ id: "feed-third", event: event(), feedback, tags: [], observedAt: "2026-10-06T00:00:00.000Z" });

  const pageOne = await brain.readAfter(0n, 2);
  const pageTwo = await brain.readAfter(pageOne.at(-1)!.sequence, 2);
  assert.deepEqual(pageOne.map(({ experience }) => experience.id), ["feed-first", "feed-second"]);
  assert.deepEqual(pageOne.map(({ sequence }) => sequence), [1n, 2n]);
  assert.deepEqual(pageTwo.map(({ experience }) => experience.id), ["feed-third"]);
  await assert.rejects(brain.readAfter(0n, 501), /between 1 and 500/);
});

test("recall filters by feedback, hook, tag, and observed time window", async () => {
  const brain = new AgentBrain(new MemoryExperienceStore());
  const older = await brain.observe({
    id: "older",
    observedAt: "2026-01-01T00:00:00.000Z",
    event: event(),
    feedback,
    tags: ["solana", "liquidation"],
    evidence: { channel: "simulation", status: "observed" },
  });
  const newer = await brain.observe({
    id: "newer",
    observedAt: "2026-02-01T00:00:00.000Z",
    event: event(),
    feedback: { ...feedback, outcome: "rejected", accepted: false },
    tags: ["solana", "borrow"],
  });

  assert.deepEqual((await brain.recall({ outcome: "rejected", hookProgramId: "hook-a" })).map(({ id }) => id), [newer.id]);
  assert.deepEqual((await brain.recall({ tag: "liquidation", until: "2026-01-15T00:00:00.000Z" })).map(({ id }) => id), [older.id]);
  assert.deepEqual((await brain.recall({ since: "2026-01-15T00:00:00.000Z" })).map(({ id }) => id), [newer.id]);
  await assert.rejects(brain.recall({ since: "bad-date" }), /since must be a valid date/);
  await assert.rejects(brain.recall({ since: "2026-03-01", until: "2026-02-01" }), /earlier than or equal/);
});
