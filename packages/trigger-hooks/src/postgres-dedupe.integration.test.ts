import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";

import { PostgresDedupeStore, type TriggerPostgreSqlExecutor } from "./postgres-dedupe.js";

const databaseUrl = process.env.AGENT_HOOKS_TEST_DATABASE_URL;

test("PostgreSQL trigger claims are atomic, restart-safe, and recover expired leases", { skip: !databaseUrl }, async () => {
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  const schema = `agent_hooks_trigger_it_${process.pid}_${Date.now()}`;
  const quotedSchema = `"${schema}"`;
  const now = new Date("2026-11-16T12:00:00.000Z");
  let poolA: Pool | undefined;
  let poolB: Pool | undefined;

  try {
    await admin.query(`CREATE SCHEMA ${quotedSchema}`);
    poolA = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    poolB = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    const executor = (pool: Pool): TriggerPostgreSqlExecutor => ({
      query: async (statement, parameters = []) => {
        const result = await pool.query(statement, parameters);
        return { rows: result.rows as Record<string, unknown>[] };
      },
    });
    const storeA = new PostgresDedupeStore(executor(poolA), { leaseMilliseconds: 1_000, now: () => now });
    const storeB = new PostgresDedupeStore(executor(poolB), { leaseMilliseconds: 1_000, now: () => now });
    await storeA.initialize();

    const concurrentClaims = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      (index % 2 ? storeA : storeB).acquire("solana:mainnet:tx-atomic:whale")));
    const winner = concurrentClaims.filter((token): token is string => token !== undefined);
    assert.equal(winner.length, 1, "concurrent connections have a single claim winner");
    await storeA.complete("solana:mainnet:tx-atomic:whale", winner[0]!);
    assert.equal(await storeB.acquire("solana:mainnet:tx-atomic:whale"), undefined, "completed delivery remains deduplicated after reconnect");

    const abandoned = await storeA.acquire("ethereum:mainnet:tx-expired:log-0");
    assert.ok(abandoned);
    const later = new Date(now.getTime() + 1_001);
    const recoveringStore = new PostgresDedupeStore(executor(poolB), { leaseMilliseconds: 1_000, now: () => later });
    const recovered = await recoveringStore.acquire("ethereum:mainnet:tx-expired:log-0");
    assert.ok(recovered);
    assert.notEqual(recovered, abandoned);
    await storeA.releaseClaim("ethereum:mainnet:tx-expired:log-0", abandoned!);
    assert.equal(await storeB.acquire("ethereum:mainnet:tx-expired:log-0"), undefined, "stale owner cannot delete the recovery lease");
    await recoveringStore.complete("ethereum:mainnet:tx-expired:log-0", recovered!);

    assert.equal(await recoveringStore.pruneRetained(new Date(later.getTime() + 10_000), 10), 2);
    assert.ok(await storeB.acquire("solana:mainnet:tx-atomic:whale"), "records can be retried after the explicitly chosen retention cutoff");
  } finally {
    await poolA?.end();
    await poolB?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await admin.end();
  }
});
