import type { PublicKey } from "@solana/web3.js";
import type { LifecycleEvent, LifecycleEventKind } from "@agent-hooks/contracts";

export type {
  LifecycleEvent,
  LifecycleEventKind,
  MarketSnapshot,
  OraclePoint,
  PositionSnapshot,
} from "@agent-hooks/contracts";

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
