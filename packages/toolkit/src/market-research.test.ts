import assert from "node:assert/strict";
import test from "node:test";
import { getCoinMarkets, getDexPairs, researchAssets } from "./market-research.js";

const now = () => new Date("2026-10-17T12:00:00.000Z");
const fakeFetch = (payload: unknown) => (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;

test("CoinGecko adapter returns source-attributed market fields and rejects malformed values", async () => {
  const assets = await getCoinMarkets(["solana"], { fetch: fakeFetch([{ id: "solana", symbol: "sol", name: "Solana", current_price: 120, market_cap: null, total_volume: 5, price_change_percentage_24h: -2 }]), now });
  assert.equal(assets[0]?.priceUsd, 120);
  assert.equal(assets[0]?.marketCapUsd, null);
  assert.equal(assets[0]?.observedAt, "2026-10-17T12:00:00.000Z");
  assert.equal(assets[0]?.source, "coingecko:coins/markets");
  await assert.rejects(getCoinMarkets(["bad id"], { fetch: fakeFetch([]) }), /valid CoinGecko/);
  await assert.rejects(getCoinMarkets(["solana"], { fetch: fakeFetch({}) }), /invalid market response/);
});

test("DEX pair adapter validates addresses and preserves missing liquidity as null", async () => {
  const mint = "So11111111111111111111111111111111111111112";
  const pairs = await getDexPairs(mint, { fetch: fakeFetch({ pairs: [{ chainId: "solana", dexId: "test", pairAddress: mint, baseToken: { address: mint, symbol: "SOL", name: "Solana" }, quoteToken: { address: mint, symbol: "USDC", name: "USD Coin" }, priceUsd: null }] }) });
  assert.equal(pairs[0]?.liquidityUsd, null);
  assert.equal(pairs[0]?.source, "dexscreener:token-pairs");
  await assert.rejects(getDexPairs("not-an-address", { fetch: fakeFetch({ pairs: [] }) }), /base58/);
  await assert.rejects(getDexPairs(mint, { fetch: fakeFetch({ pairs: [{ chainId: "solana", dexId: "test", pairAddress: mint, baseToken: { address: mint, symbol: "SOL", name: "Solana" }, quoteToken: { address: mint, symbol: "USDC", name: "USD Coin" }, priceUsd: "NaN" }] }) }), /non-finite/);
  await assert.rejects(getDexPairs(mint, { fetch: fakeFetch({ pairs: [{ priceUsd: "NaN" }] }) }), /malformed/);
});

test("research report combines providers and labels limitations", async () => {
  const report = await researchAssets({ coinIds: ["solana"] }, { fetch: fakeFetch([{ id: "solana", symbol: "sol", name: "Solana", current_price: 1, market_cap: 2, total_volume: 3, price_change_percentage_24h: 4 }]), now });
  assert.equal(report.assets.length, 1);
  assert.equal(report.generatedAt, "2026-10-17T12:00:00.000Z");
  assert.ok(report.caveats.length > 0);
});
