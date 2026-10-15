import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryDedupeStore, TriggerEngine, parseSignedWebhook, type ChainObservation } from "./index.js";

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

describe("TriggerEngine", () => {
  it("matches, wakes, and deduplicates an observation", async () => {
    const wakes: string[] = [];
    const engine = new TriggerEngine({
      triggers: [{ id: "whale", predicate: { programIds: [observation.programId] } }],
      dedupe: new MemoryDedupeStore(),
      dispatcher: { wake: async ({ trigger }) => { wakes.push(trigger.id); } },
    });
    assert.equal((await engine.ingest(observation)).length, 1);
    assert.equal((await engine.ingest(observation)).length, 0);
    assert.deepEqual(wakes, ["whale"]);
  });

  it("releases the dedupe claim when delivery fails", async () => {
    let attempts = 0;
    const engine = new TriggerEngine({
      triggers: [{ id: "retryable", predicate: {} }],
      dispatcher: { wake: async () => { attempts += 1; if (attempts === 1) throw new Error("temporary"); } },
    });
    await assert.rejects(engine.ingest(observation), /temporary/);
    assert.equal((await engine.ingest(observation)).length, 1);
    assert.equal(attempts, 2);
  });

  it("matches configurable category, network, asset, and severity alerts", async () => {
    const engine = new TriggerEngine({
      triggers: [{
        id: "sol-whale-warning",
        predicate: {
          alertCategories: ["whale_movement"],
          networks: ["solana-mainnet"],
          assetSymbols: ["USDC"],
          minimumSeverity: "warning",
        },
      }],
      dispatcher: { wake: async () => undefined },
    });
    const financeObservation: ChainObservation = {
      ...observation,
      financeAlert: {
        category: "whale_movement",
        network: "solana-mainnet",
        severity: "warning",
        assetSymbols: ["usdc"],
      },
    };
    assert.equal((await engine.ingest(financeObservation)).length, 1);
  });

  it("requires every configured numeric metric condition to match", async () => {
    let wakes = 0;
    const engine = new TriggerEngine({
      triggers: [{
        id: "high-risk-position",
        predicate: {
          alertCategories: ["liquidation_risk"],
          metricConditions: [
            { metric: "ltvBps", operator: "gte", value: 8_000 },
            { metric: "healthFactor", operator: "lt", value: 1.1 },
          ],
        },
      }],
      dispatcher: { wake: async () => { wakes += 1; } },
    });
    const financeObservation: ChainObservation = {
      ...observation,
      financeAlert: {
        category: "liquidation_risk",
        network: "solana-mainnet",
        severity: "critical",
        metrics: { ltvBps: 8_400, healthFactor: 1.04 },
      },
    };
    assert.equal((await engine.ingest(financeObservation)).length, 1);
    assert.equal(wakes, 1);
  });
});

describe("signed webhooks", () => {
  it("requires a fresh HMAC signature", () => {
    const body = JSON.stringify({ ...observation, slot: observation.slot.toString() });
    const timestamp = "1700000000";
    const signature = `sha256=${createHmac("sha256", "secret").update(`${timestamp}.${body}`).digest("hex")}`;
    assert.equal(parseSignedWebhook(body, { signature, timestamp }, { secret: "secret", nowSeconds: () => 1700000001 }).sourceVerified, true);
    assert.throws(() => parseSignedWebhook(body, { signature, timestamp: "1" }, { secret: "secret", nowSeconds: () => 1700000001 }));
  });
});
