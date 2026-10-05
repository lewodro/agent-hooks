import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";

import type { Experience } from "./memory.js";
import { PostgresExperienceStore, type PostgreSqlExecutor } from "./postgres.js";

const databaseUrl = process.env.AGENT_HOOKS_TEST_DATABASE_URL;

test("PostgreSQL migration, durable replay, and concurrent appends", { skip: !databaseUrl }, async () => {
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  // This identifier is generated locally and restricted to alphanumeric/underscore.
  const schema = `agent_hooks_it_${process.pid}_${Date.now()}`;
  const quotedSchema = `"${schema}"`;
  let pool: Pool | undefined;

  try {
    await admin.query(`CREATE SCHEMA ${quotedSchema}`);

    // Recreate the pre-feed schema so initialize() must backfill its cursor.
    pool = new Pool({
      connectionString: databaseUrl,
      max: 8,
      options: `-c search_path=${schema}`,
    });
    await pool.query(`CREATE TABLE agent_hook_experiences (
      experience_id TEXT PRIMARY KEY,
      record_hash CHAR(64) NOT NULL,
      schema_version SMALLINT NOT NULL CHECK (schema_version = 1),
      observed_at TIMESTAMPTZ NOT NULL,
      adapter TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      composition_id TEXT NOT NULL,
      evidence_channel TEXT NOT NULL,
      evidence_status TEXT NOT NULL,
      payload JSONB NOT NULL
    )`);

    const legacy = experience("legacy-row", 42n);
    const legacyPayload = structuredClone(legacy) as unknown as { event: { market: { slot: unknown } } };
    legacyPayload.event.market.slot = 42;
    await pool.query(
      `INSERT INTO agent_hook_experiences (
        experience_id, record_hash, schema_version, observed_at, adapter, event_kind,
        composition_id, evidence_channel, evidence_status, payload
      ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [legacy.id, "a".repeat(64), legacy.observedAt, legacy.event.adapter, legacy.event.kind,
        legacy.feedback.compositionId, legacy.evidence.channel, legacy.evidence.status, JSON.stringify(legacyPayload)],
    );

    const executor: PostgreSqlExecutor = {
      query: async (statement, parameters = []) => {
        const result = await pool!.query(statement, parameters);
        return { rows: result.rows as Record<string, unknown>[] };
      },
    };
    const store = new PostgresExperienceStore(executor);
    await store.initialize();

    const migrated = await store.readAfter(0n, 10);
    assert.deepEqual(migrated.map(({ sequence }) => sequence), [1n]);
    assert.equal(migrated[0]?.experience.event.market.slot, 42n, "legacy numeric slot is restored exactly");

    const exactIntegers = experience("large-integers", (1n << 53n) + 11n);
    exactIntegers.event.market.oraclePoints.push({
      mint: "oracle-mint",
      priceE8: (1n << 53n) + 13n,
      confidenceE8: 500_000_000_000_000n,
      slot: exactIntegers.event.market.slot,
    });
    await store.append(exactIntegers);
    await store.append(structuredClone(exactIntegers));
    await assert.rejects(
      store.append({ ...exactIntegers, tags: ["same-id-different-content"] }),
      /already exists with different content/,
    );

    const concurrent = Array.from({ length: 12 }, (_, index) => experience(`concurrent-${index}`, BigInt(index + 100)));
    await Promise.all(concurrent.map((record) => store.append(record)));

    const all = await store.readAfter(0n, 100);
    const sequences = all.map(({ sequence }) => sequence);
    assert.equal(all.length, 14, "one legacy, one exact-integer, and twelve concurrent rows");
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
    assert.equal(new Set(sequences.map(String)).size, sequences.length, "ingest sequence is unique");
    assert.equal(all.find(({ experience: item }) => item.id === exactIntegers.id)?.experience.event.market.slot,
      exactIntegers.event.market.slot);
    assert.equal(all.find(({ experience: item }) => item.id === exactIntegers.id)?.experience.event.market.oraclePoints[0]?.priceE8,
      exactIntegers.event.market.oraclePoints[0]?.priceE8);

    const page = await store.readAfter(1n, 3);
    assert.equal(page.length, 3);
    assert.ok(page.every(({ sequence }) => sequence > 1n));
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await admin.end();
  }
});

function experience(id: string, slot: bigint): Experience {
  return {
    schemaVersion: 1,
    id,
    observedAt: "2026-10-05T12:00:00.000Z",
    event: {
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
      market: { slot, timestamp: 1_700_000_000, realisedVolBps: 400, utilisationBps: 5_000, oraclePoints: [] },
      payload: [],
    },
    feedback: {
      compositionId: "sol-usdc-v1",
      hookProgramIds: ["hook-a"],
      accepted: true,
      outcome: "executed",
      reward: 0.7,
      rewardUnit: "normalized_0_1",
    },
    evidence: { channel: "unknown", status: "unverified" },
    trace: [{ hookId: "hook-a", decision: "accepted" }],
    tags: ["solana"],
  };
}
