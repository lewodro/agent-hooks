import type { PublicKey } from "@solana/web3.js";

export type LifecycleEventKind =
  | "beforeDeposit"
  | "afterDeposit"
  | "beforeBorrow"
  | "afterBorrow"
  | "beforeRepay"
  | "afterRepay"
  | "beforeLiquidate"
  | "afterLiquidate";

export interface PositionSnapshot {
  owner: string;
  collateralMint: string;
  debtMint: string;
  collateralAmount: number;
  debtAmount: number;
  ltvBps: number;
  liquidationThresholdBps: number;
}

export interface OraclePoint {
  mint: string;
  priceE8: bigint;
  confidenceE8: bigint;
  slot: bigint;
}

export interface MarketSnapshot {
  slot: number;
  timestamp: number;
  realisedVolBps: number;
  utilisationBps: number;
  oraclePoints: OraclePoint[];
}

export interface LifecycleEvent {
  kind: LifecycleEventKind;
  adapter: "marginfi" | "kamino" | "solend";
  position: PositionSnapshot;
  market: MarketSnapshot;
  payload: number[];
}

export interface ReserveSnapshot {
  mint: string;
  symbol: string;
  depositApyBps: number;
  borrowApyBps: number;
}

export interface PoolSnapshot {
  adapter: "marginfi" | "kamino" | "solend";
  market: PublicKey;
  totalAssetsUsd: number;
  totalLiabilitiesUsd: number;
  utilisationBps: number;
  reserves: ReserveSnapshot[];
}

export interface LendingAdapter {
  readonly kind: "marginfi" | "kamino" | "solend";
  programId(): PublicKey;
  snapshotPool(market: PublicKey): Promise<PoolSnapshot>;
  syntheticEvent(args: {
    accountPubkey: PublicKey;
    kind: LifecycleEventKind;
    payload?: Uint8Array;
  }): Promise<LifecycleEvent>;
}

/** Normalize USD totals to bounded basis points shared by all protocol adapters. */
export function computeUtilisationBps(totalAssetsUsd: number, totalLiabilitiesUsd: number): number {
  if (!Number.isFinite(totalAssetsUsd) || totalAssetsUsd < 0) {
    throw new RangeError("total assets must be a non-negative finite USD value");
  }
  if (!Number.isFinite(totalLiabilitiesUsd) || totalLiabilitiesUsd < 0) {
    throw new RangeError("total liabilities must be a non-negative finite USD value");
  }
  if (totalAssetsUsd === 0) return totalLiabilitiesUsd > 0 ? 10_000 : 0;
  return Math.min(10_000, Math.round((totalLiabilitiesUsd / totalAssetsUsd) * 10_000));
}
