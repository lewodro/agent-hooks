/** Lifecycle points supported by the current Solana lending adapters. */
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
  /** Solana slot as an exact unsigned integer; do not round through JS number. */
  slot: bigint;
  timestamp: number;
  realisedVolBps: number;
  utilisationBps: number;
  oraclePoints: OraclePoint[];
}

/** Normalized event contract; adapters translate protocol data into this shape. */
export interface LifecycleEvent {
  kind: LifecycleEventKind;
  adapter: "marginfi" | "kamino" | "solend";
  position: PositionSnapshot;
  market: MarketSnapshot;
  payload: number[];
}
