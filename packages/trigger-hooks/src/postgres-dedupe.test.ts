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
    if (statement.includes("WITH old_claims AS")) {
      const [before, limit] = parameters as [Date, number];
      const expired = [...this.claims.entries()]
        .filter(([, row]) => row.completedAt ? row.completedAt <= before : row.expiresAt <= before)
        .sort((left, right) => {
          const leftTime = (left[1].completedAt ?? left[1].expiresAt).getTime();
          const rightTime = (right[1].completedAt ?? right[1].expiresAt).getTime();
          return leftTime - rightTime;
        })
        .slice(0, limit);
      for (const [key] of expired) this.claims.delete(key);
      return { rows: expired.map(([claim_key]) => ({ claim_key })) };
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

test("claim retention prunes bounded expired rows without touching active leases", async () => {
  let clock = new Date("2026-11-16T12:00:00.000Z");
  const db = new FakePostgres();
  const store = new PostgresDedupeStore(db, { leaseMilliseconds: 1_000, now: () => clock });
  await store.initialize();
  const completedToken = await store.acquire("completed-old");
  await store.complete("completed-old", completedToken!);
  await store.acquire("abandoned-old");
  clock = new Date(clock.getTime() + 2_000);
  await store.acquire("active-new");

  const cutoff = new Date("2026-11-16T12:00:02.500Z");
  assert.equal(await store.pruneRetained(cutoff, 1), 1, "pruning is bounded by the requested batch size");
  assert.equal(await store.pruneRetained(cutoff), 1);
  assert.equal(await store.pruneRetained(cutoff), 0);
  assert.equal(await store.acquire("active-new"), undefined, "active lease remains claimed");
  assert.equal(await store.acquire("completed-old") !== undefined, true, "pruned history is eligible after the chosen retention horizon");
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
