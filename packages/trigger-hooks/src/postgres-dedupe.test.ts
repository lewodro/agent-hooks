import assert from "node:assert/strict";
import test from "node:test";

import { PostgresDedupeStore, type TriggerPostgreSqlExecutor } from "./postgres-dedupe.js";
import { TriggerEngine, type ChainObservation } from "./index.js";

interface ClaimRow {
  token: string;
  expiresAt: Date;
  completedAt?: Date;
}

class FakePostgres implements TriggerPostgreSqlExecutor {
  readonly claims = new Map<string, ClaimRow>();

  async query(statement: string, parameters: unknown[] = []): Promise<{ rows: readonly Record<string, unknown>[] }> {
    if (statement.includes("INSERT INTO agent_hook_trigger_claims")) {
      const [key, token, expiry, now] = parameters as [string, string, Date, Date];
      const existing = this.claims.get(key);
      if (!existing || (!existing.completedAt && existing.expiresAt <= now)) {
        this.claims.set(key, { token, expiresAt: expiry });
        return { rows: [{ lease_token: token }] };
      }
      return { rows: [] };
    }
    if (statement.includes("UPDATE agent_hook_trigger_claims")) {
      const [key, token, completedAt] = parameters as [string, string, Date];
      const existing = this.claims.get(key);
      if (existing?.token === token && !existing.completedAt) existing.completedAt = completedAt;
      return { rows: [] };
    }
    if (statement.includes("DELETE FROM agent_hook_trigger_claims")) {
      const [key, token] = parameters as [string, string];
      const existing = this.claims.get(key);
      if (existing?.token === token && !existing.completedAt) this.claims.delete(key);
      return { rows: [] };
    }
    return { rows: [] };
  }
}

test("PostgreSQL claims recover expired workers and fence stale releases", async () => {
  let clock = new Date("2026-11-16T12:00:00.000Z");
  const store = new PostgresDedupeStore(new FakePostgres(), { leaseMilliseconds: 1_000, now: () => clock });
  await store.initialize();

  const first = await store.acquire("solana:mainnet:signature:source");
  assert.ok(first);
  assert.equal(await store.acquire("solana:mainnet:signature:source"), undefined);

  clock = new Date(clock.getTime() + 1_001);
  const second = await store.acquire("solana:mainnet:signature:source");
  assert.ok(second);
  assert.notEqual(second, first);
  await store.releaseClaim("solana:mainnet:signature:source", first!);
  assert.equal(await store.acquire("solana:mainnet:signature:source"), undefined, "stale owner cannot release a newer lease");

  await store.complete("solana:mainnet:signature:source", second!);
  clock = new Date(clock.getTime() + 60_000);
  assert.equal(await store.acquire("solana:mainnet:signature:source"), undefined, "completed delivery remains deduplicated");
});

test("PostgreSQL claims validate key and lease bounds", async () => {
  const db = new FakePostgres();
  assert.throws(() => new PostgresDedupeStore(db, { leaseMilliseconds: 0 }), /between 1 ms and 24 hours/);
  const store = new PostgresDedupeStore(db);
  await assert.rejects(store.acquire(""), /1-1024 characters/);
  await assert.rejects(store.acquire("x".repeat(1_025)), /1-1024 characters/);
});

test("TriggerEngine completes durable claims after wake and releases failed attempts", async () => {
  const db = new FakePostgres();
  const dedupe = new PostgresDedupeStore(db);
  await dedupe.initialize();
  const observation: ChainObservation = {
    chain: "solana",
    source: "webhook",
    sourceId: "source-1",
    signature: "tx-1",
    slot: 42n,
    blockTime: 1_700_000_000,
    programId: "Program111111111111111111111111111111111111",
    sourceVerified: true,
    receivedAt: new Date(1_700_000_000_000).toISOString(),
  };
  let failuresRemaining = 1;
  let deliveries = 0;
  const engine = new TriggerEngine({
    triggers: [{ id: "durable-retry", predicate: {} }],
    dedupe,
    dispatcher: { wake: async () => {
      deliveries += 1;
      if (failuresRemaining-- > 0) throw new Error("temporary outage");
    } },
  });

  await assert.rejects(engine.ingest(observation), /temporary outage/);
  assert.equal((await engine.ingest(observation)).length, 1);
  assert.equal((await engine.ingest(observation)).length, 0);
  assert.equal(deliveries, 2);
});
