import assert from "node:assert/strict";
import test from "node:test";

import { ExperienceIdConflictError, type Experience, type ExperienceQuery } from "./memory.js";
import {
  PostgresExperienceStore,
  type PostgreSqlExecutor,
} from "./postgres.js";

class FakePostgres implements PostgreSqlExecutor {
  readonly calls: Array<{ statement: string; parameters: unknown[] }> = [];
  readonly hashes = new Map<string, string>();
  readonly payloads: Experience[] = [];

  async query(statement: string, parameters: unknown[] = []): Promise<{ rows: readonly Record<string, unknown>[] }> {
    this.calls.push({ statement, parameters });
    if (statement.includes("INSERT INTO agent_hook_experiences")) {
      const id = parameters[0] as string;
      const hash = parameters[1] as string;
      if (this.hashes.has(id)) return { rows: [] };
      this.hashes.set(id, hash);
      this.payloads.push(JSON.parse(parameters[9] as string) as Experience);
      return { rows: [{ experience_id: id }] };
    }
    if (statement.includes("SELECT record_hash")) {
      const hash = this.hashes.get(parameters[0] as string);
      return hash ? { rows: [{ record_hash: hash }] } : { rows: [] };
    }
    if (statement.includes("SELECT payload")) return { rows: this.payloads.map((payload) => ({ payload })) };
    return { rows: [] };
  }
}

function sample(id = "experience-1"): Experience {
  return {
    schemaVersion: 1,
    id,
    observedAt: "2026-10-05T12:00:00.000Z",
    event: {
      kind: "beforeBorrow",
      adapter: "solend",
      position: {
        owner: "owner", collateralMint: "collateral", debtMint: "debt", collateralAmount: 100,
        debtAmount: 50, ltvBps: 5_000, liquidationThresholdBps: 8_000,
      },
      market: { slot: 10, timestamp: 1_700_000_000, realisedVolBps: 400, utilisationBps: 5_000, oraclePoints: [] },
      payload: [],
    },
    feedback: {
      compositionId: "sol-usdc-v1", hookProgramIds: ["hook-a"], accepted: true, outcome: "executed",
      reward: 0.7, rewardUnit: "normalized_0_1",
    },
    evidence: {
      channel: "chain", status: "confirmed", network: "solana-devnet", transactionId: "signature", slot: 123,
    },
    trace: [{ hookId: "hook-a", decision: "accepted" }],
    tags: ["solana"],
  };
}

test("PostgreSQL store initializes indexes and performs idempotent append", async () => {
  const db = new FakePostgres();
  const store = new PostgresExperienceStore(db);
  await store.initialize();
  assert.equal(db.calls.length, 8);
  const item = sample();
  await store.append(item);
  await store.append({ ...item, tags: [...item.tags] });
  assert.equal(db.payloads.length, 1);
  assert.match(db.calls[8]!.statement, /ON CONFLICT \(experience_id\) DO NOTHING/);
});

test("PostgreSQL store rejects the same ID with different record content", async () => {
  const store = new PostgresExperienceStore(new FakePostgres());
  const item = sample();
  await store.append(item);
  await assert.rejects(
    store.append({ ...item, feedback: { ...item.feedback, reward: 0.8 } }),
    ExperienceIdConflictError,
  );
});

test("PostgreSQL queries bind filters, cap results, and require chain evidence identities", async () => {
  const db = new FakePostgres();
  const store = new PostgresExperienceStore(db);
  const item = sample();
  await store.append(item);
  const query: ExperienceQuery = {
    adapter: "solend", kind: "beforeBorrow", compositionId: "sol-usdc-v1", outcome: "executed",
    hookProgramId: "hook-a", tag: "solana", since: "2026-10-01T00:00:00.000Z",
    verifiedOnly: true, limit: 999,
  };
  const found = await store.query(query);
  const statement = db.calls.at(-1)!;
  assert.deepEqual(found.map(({ id }) => id), [item.id]);
  assert.match(statement.statement, /evidence_status IN \('confirmed', 'finalized'\)/);
  assert.match(statement.statement, /transactionId/);
  assert.match(statement.statement, /hookProgramIds/);
  assert.match(statement.statement, /observed_at >=/);
  assert.deepEqual(statement.parameters, [
    "solend", "beforeBorrow", "sol-usdc-v1", "executed", "hook-a", "solana", "2026-10-01T00:00:00.000Z", 200,
  ]);
  assert.equal(statement.statement.includes("sol-usdc-v1"), false, "untrusted filters are parameterized");
});

test("PostgreSQL preserves large oracle integers across JSON persistence", async () => {
  const store = new PostgresExperienceStore(new FakePostgres());
  const item = sample();
  const priceE8 = 9_007_199_254_740_993n;
  const confidenceE8 = 12_345_678_901_234_567n;
  item.event.market.oraclePoints.push({
    mint: "mint-a",
    priceE8,
    confidenceE8,
    slot: 9_007_199_254_740_999n,
  });

  await store.append(item);
  const [restored] = await store.query({});
  assert.equal(restored?.event.market.oraclePoints[0]?.priceE8, priceE8);
  assert.equal(restored?.event.market.oraclePoints[0]?.confidenceE8, confidenceE8);
  assert.equal(restored?.event.market.oraclePoints[0]?.slot, 9_007_199_254_740_999n);
});

test("PostgreSQL rejects malformed records already present in storage", async () => {
  const db = new FakePostgres();
  const store = new PostgresExperienceStore(db);
  await store.append(sample());
  const persisted = db.payloads[0] as unknown as { feedback: { outcome: string } };
  persisted.feedback.outcome = "invented-outcome";

  await assert.rejects(store.query({}), /feedback outcome or accepted flag is invalid/);
});
