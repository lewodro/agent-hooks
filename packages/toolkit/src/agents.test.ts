import assert from "node:assert/strict";
import test from "node:test";

import {
  ExperienceIdConflictError,
  MemoryExperienceStore,
} from "./agents.js";
import type { AgentExperience } from "./agents.js";

function experience(id: string, recordedAt: number, tags: readonly string[] = ["solana"]): AgentExperience {
  return {
    id,
    recordedAt,
    event: {
      signature: `sig-${id}`,
      slot: 42,
      timestamp: recordedAt,
      kind: "beforeBorrow",
      programId: "marginfi-program",
      data: {},
    },
    run: { accepted: true, receipts: [] },
    outcome: { label: "executed", reward: 0.5 },
    tags,
  };
}

test("memory experience store is bounded, idempotent, and queryable", async () => {
  const store = new MemoryExperienceStore(2);
  const first = experience("first", 1);
  await store.append(first);
  await store.append(first);
  await store.append(experience("second", 2, ["marginfi"]));
  await store.append(experience("third", 3));

  assert.deepEqual((await store.search({})).map((item) => item.id), ["third", "second"]);
  assert.deepEqual((await store.search({ tags: ["solana"] })).map((item) => item.id), ["third"]);
  const snapshot = await store.search({});
  snapshot[0]!.outcome.label = "changed";
  assert.equal((await store.search({}))[0]!.outcome.label, "executed");
});

test("memory experience store rejects conflicting IDs and malformed experiences", async () => {
  const store = new MemoryExperienceStore();
  await store.append(experience("same", 1));
  await assert.rejects(
    store.append({ ...experience("same", 1), outcome: { label: "different" } }),
    ExperienceIdConflictError,
  );
  await assert.rejects(store.append(experience("", 1)), /id is required/);
  await assert.rejects(store.append({ ...experience("bad", 1), tags: [""] }), /empty values/);
  assert.throws(() => new MemoryExperienceStore(0), /maxRecords/);
});
