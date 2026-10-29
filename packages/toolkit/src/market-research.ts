/** Read-only crypto market research with explicit source and observation timestamps. */
export interface MarketSnapshot {
  assetId: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  observedAt: string;
  source: string;
}

export interface DexPairSnapshot {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  pairCreatedAt: string | null;
  /** Local receipt time for this provider response; not the chain's pair creation time. */
  observedAt: string;
  source: string;
}

export interface ResearchReport {
  generatedAt: string;
  assets: readonly MarketSnapshot[];
  pairs: readonly DexPairSnapshot[];
  caveats: readonly string[];
}

export interface ResearchOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  coingeckoApiKey?: string;
  coingeckoBaseUrl?: string;
  dexscreenerBaseUrl?: string;
}

/** CoinGecko /coins/markets adapter. IDs are provider IDs (e.g. `solana`), not symbols. */
export async function getCoinMarkets(ids: readonly string[], options: ResearchOptions = {}): Promise<MarketSnapshot[]> {
  if (ids.length < 1 || ids.length > 100 || ids.some((id) => !/^[a-z0-9-]{1,80}$/.test(id))) {
    throw new Error("provide 1-100 valid CoinGecko coin IDs");
  }
  const url = new URL("/api/v3/coins/markets", options.coingeckoBaseUrl ?? "https://api.coingecko.com");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("ids", [...new Set(ids)].join(","));
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", "1");
  const headers = new Headers({ accept: "application/json" });
  if (options.coingeckoApiKey) headers.set("x-cg-demo-api-key", options.coingeckoApiKey);
  const response = await (options.fetch ?? globalThis.fetch)(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`CoinGecko market request failed (${response.status})`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error("CoinGecko returned an invalid market response");
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  return payload.map((row: unknown) => {
    const item = record(row, "CoinGecko market row");
    return {
      assetId: stringField(item, "id"), symbol: stringField(item, "symbol").toUpperCase(), name: stringField(item, "name"),
      priceUsd: nonNegativeNumber(item.current_price), marketCapUsd: nonNegativeNumber(item.market_cap),
      volume24hUsd: nonNegativeNumber(item.total_volume), change24hPct: nullableNumber(item.price_change_percentage_24h),
      observedAt, source: "coingecko:coins/markets",
    };
  });
}

/** DEX Screener pair lookup for a token address. Token symbols are never treated as identities. */
export async function getDexPairs(tokenAddress: string, options: ResearchOptions = {}): Promise<DexPairSnapshot[]> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenAddress)) throw new Error("tokenAddress must be a base58 address");
  const base = options.dexscreenerBaseUrl ?? "https://api.dexscreener.com";
  const response = await (options.fetch ?? globalThis.fetch)(new URL(`/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`, base), {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`DEX Screener pair request failed (${response.status})`);
  const payload: unknown = await response.json();
  const rows = record(payload, "DEX Screener response").pairs;
  if (rows !== null && rows !== undefined && !Array.isArray(rows)) throw new Error("DEX Screener returned invalid pairs");
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  return (rows ?? []).slice(0, 100).map((row: unknown) => {
    const item = record(row, "DEX pair");
    const baseToken = record(item.baseToken, "DEX base token");
    const quoteToken = record(item.quoteToken, "DEX quote token");
    const liquidity = item.liquidity === null || item.liquidity === undefined ? null : record(item.liquidity, "DEX liquidity");
    const change = item.priceChange === null || item.priceChange === undefined ? null : record(item.priceChange, "DEX price change");
    const createdAt = nonNegativeNumber(item.pairCreatedAt);
    return {
      chainId: stringField(item, "chainId"), dexId: stringField(item, "dexId"), pairAddress: stringField(item, "pairAddress"),
      baseToken: { address: stringField(baseToken, "address"), symbol: stringField(baseToken, "symbol"), name: stringField(baseToken, "name") },
      quoteToken: { address: stringField(quoteToken, "address"), symbol: stringField(quoteToken, "symbol"), name: stringField(quoteToken, "name") },
      priceUsd: nonNegativeNumber(item.priceUsd), liquidityUsd: liquidity ? nonNegativeNumber(liquidity.usd) : null,
      volume24hUsd: item.volume === null || item.volume === undefined ? null : nonNegativeNumber(record(item.volume, "DEX volume").h24),
      priceChange24hPct: change ? nullableNumber(change.h24) : null,
      pairCreatedAt: createdAt === null ? null : new Date(createdAt).toISOString(), observedAt, source: "dexscreener:token-pairs",
    };
  });
}

export async function researchAssets(input: { coinIds?: readonly string[]; tokenAddresses?: readonly string[] }, options: ResearchOptions = {}): Promise<ResearchReport> {
  if ((input.coinIds?.length ?? 0) + (input.tokenAddresses?.length ?? 0) === 0) throw new Error("at least one coin ID or token address is required");
  if ((input.tokenAddresses?.length ?? 0) > 25) throw new Error("at most 25 token addresses may be researched per report");
  const coinIds = [...new Set(input.coinIds ?? [])];
  const tokenAddresses = [...new Set(input.tokenAddresses ?? [])];
  const [assets, pairGroups] = await Promise.all([
    coinIds.length ? getCoinMarkets(coinIds, options) : Promise.resolve([]),
    Promise.all(tokenAddresses.map((address) => getDexPairs(address, options))),
  ]);
  return {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(), assets, pairs: pairGroups.flat(),
    caveats: ["Market snapshots are provider observations, not independently verified prices.", "Liquidity and volume can be incomplete or manipulated; this report is not investment advice."],
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
}
function stringField(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string") throw new Error(`provider field ${key} is missing or invalid`);
  return value[key] as string;
}
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("provider returned a non-finite numeric field");
  return value;
}
function nonNegativeNumber(value: unknown): number | null {
  const number = nullableNumber(value);
  if (number !== null && number < 0) throw new Error("provider returned a negative value for a non-negative market field");
  return number;
}
