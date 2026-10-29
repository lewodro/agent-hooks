import type { ResearchReport } from "./market-research.js";

export type MarketAlertMetric =
  | "priceUsd"
  | "marketCapUsd"
  | "volume24hUsd"
  | "change24hPct"
  | "liquidityUsd"
  | "priceChange24hPct";
export type MarketAlertOperator = "gt" | "gte" | "lt" | "lte" | "eq";
export type MarketAlertSeverity = "info" | "warning" | "critical";

/** A provider-data threshold only. It does not encode an order or trading instruction. */
export interface MarketAlertRule {
  id: string;
  /** Exact CoinGecko ID, DEX pair address, or chain-qualified pair key. Symbols are not identities. */
  assetKey: string;
  metric: MarketAlertMetric;
  operator: MarketAlertOperator;
  threshold: number;
  severity: MarketAlertSeverity;
  maxAgeMs: number;
  minimumLiquidityUsd?: number;
}

export interface MarketAlert {
  id: string;
  ruleId: string;
  assetKey: string;
  metric: MarketAlertMetric;
  operator: MarketAlertOperator;
  threshold: number;
  observedValue: number;
  severity: MarketAlertSeverity;
  source: string;
  observedAt: string;
}

/** Evaluate source-attributed, freshness-bounded research results against deterministic rules. */
export function evaluateMarketAlerts(
  report: ResearchReport,
  rules: readonly MarketAlertRule[],
  options: { now?: () => Date } = {},
): MarketAlert[] {
  const now = (options.now ?? (() => new Date()))().getTime();
  if (!Number.isFinite(now)) throw new Error("market alert clock must return a valid date");
  for (const rule of rules) validateRule(rule);

  const candidates = [
    ...report.assets.map((snapshot) => ({
      assetKey: `coingecko:${snapshot.assetId}`,
      snapshot,
      metrics: snapshot as unknown as Readonly<Record<string, number | null>>,
      liquidityUsd: null,
    })),
    ...report.pairs.map((snapshot) => ({
      assetKey: `${snapshot.chainId}:${snapshot.pairAddress}`,
      snapshot,
      metrics: snapshot as unknown as Readonly<Record<string, number | null>>,
      liquidityUsd: snapshot.liquidityUsd,
    })),
  ];

  const alerts: MarketAlert[] = [];
  for (const rule of rules) {
    for (const candidate of candidates) {
      if (candidate.assetKey !== rule.assetKey) continue;
      const observedAt = Date.parse(candidate.snapshot.observedAt);
      const ageMs = now - observedAt;
      if (!Number.isFinite(observedAt) || ageMs < 0 || ageMs > rule.maxAgeMs) continue;
      if (rule.minimumLiquidityUsd !== undefined && (candidate.liquidityUsd === null || candidate.liquidityUsd < rule.minimumLiquidityUsd)) continue;
      const value = candidate.metrics[rule.metric];
      if (typeof value !== "number" || !Number.isFinite(value) || !matches(value, rule.operator, rule.threshold)) continue;
      const observedAtIso = new Date(observedAt).toISOString();
      alerts.push({
        id: `${rule.id}:${candidate.assetKey}:${candidate.snapshot.source}:${observedAtIso}`,
        ruleId: rule.id,
        assetKey: candidate.assetKey,
        metric: rule.metric,
        operator: rule.operator,
        threshold: rule.threshold,
        observedValue: value,
        severity: rule.severity,
        source: candidate.snapshot.source,
        observedAt: observedAtIso,
      });
    }
  }
  return alerts;
}

function validateRule(rule: MarketAlertRule): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(rule.id)) throw new Error("market alert rule ID is invalid");
  if (!rule.assetKey.trim() || rule.assetKey.length > 160) throw new Error("market alert assetKey is invalid");
  if (!( ["priceUsd", "marketCapUsd", "volume24hUsd", "change24hPct", "liquidityUsd", "priceChange24hPct"] as string[]).includes(rule.metric)) {
    throw new Error("market alert metric is unsupported");
  }
  if (!( ["gt", "gte", "lt", "lte", "eq"] as string[]).includes(rule.operator)) throw new Error("market alert operator is unsupported");
  if (!Number.isFinite(rule.threshold)) throw new Error("market alert threshold must be finite");
  if (!Number.isSafeInteger(rule.maxAgeMs) || rule.maxAgeMs < 1_000 || rule.maxAgeMs > 86_400_000) {
    throw new Error("market alert maxAgeMs must be between 1000 and 86400000");
  }
  if (!(["info", "warning", "critical"] as string[]).includes(rule.severity)) throw new Error("market alert severity is unsupported");
  if (rule.minimumLiquidityUsd !== undefined && (!Number.isFinite(rule.minimumLiquidityUsd) || rule.minimumLiquidityUsd < 0)) {
    throw new Error("minimumLiquidityUsd must be finite and non-negative");
  }
}

function matches(value: number, operator: MarketAlertOperator, threshold: number): boolean {
  switch (operator) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "eq": return value === threshold;
  }
}
