import { Connection, PublicKey } from "@solana/web3.js";
import {
  KaminoMarket,
  KaminoObligation,
  PROGRAM_ID as KLEND_PROGRAM_ID,
} from "@kamino-finance/klend-sdk";

import type {
  LendingAdapter,
  LifecycleEvent,
  LifecycleEventKind,
  PoolSnapshot,
  PositionSnapshot,
  ReserveSnapshot,
} from "./types.js";

export const KAMINO_PROGRAM_ID = new PublicKey(KLEND_PROGRAM_ID);

export interface KaminoAdapterOptions {
  rpcEndpoint: string;
  marketAddress: PublicKey;
}

export class KaminoAdapter implements LendingAdapter {
  public readonly kind = "kamino" as const;
  private readonly options: KaminoAdapterOptions;
  private market: KaminoMarket | null = null;

  constructor(options: KaminoAdapterOptions) {
    this.options = options;
  }

  programId(): PublicKey {
    return KAMINO_PROGRAM_ID;
  }

  async loadMarket(): Promise<KaminoMarket> {
    if (this.market) return this.market;
    const connection = new Connection(this.options.rpcEndpoint, "confirmed");
    const market = await KaminoMarket.load(connection, this.options.marketAddress);
    if (!market) {
      throw new Error(`Kamino market ${this.options.marketAddress.toBase58()} not found`);
    }
    this.market = market;
    return market;
  }

  async snapshotPool(market: PublicKey): Promise<PoolSnapshot> {
    const m = await this.loadMarket();
    const reserves: ReserveSnapshot[] = [];
    let totalAssets = 0;
    let totalLiabilities = 0;
    for (const reserve of m.reserves.values()) {
      const supplyApy = reserve.totalSupplyAPY() * 10_000;
      const borrowApy = reserve.totalBorrowAPY() * 10_000;
      const assets = Number(reserve.getTotalSupply().toString());
      const liabilities = Number(reserve.getBorrowedAmount().toString());
      totalAssets += assets;
      totalLiabilities += liabilities;
      reserves.push({
        mint: reserve.getLiquidityMint().toBase58(),
        symbol: reserve.symbol ?? reserve.getLiquidityMint().toBase58().slice(0, 4),
        depositApyBps: Math.round(supplyApy),
        borrowApyBps: Math.round(borrowApy),
      });
    }
    return {
      adapter: "kamino",
      market,
      totalAssetsUsd: totalAssets,
      totalLiabilitiesUsd: totalLiabilities,
      utilisationBps:
        totalAssets > 0
          ? Math.min(10_000, Math.round((totalLiabilities / totalAssets) * 10_000))
          : 0,
      reserves,
    };
  }

  async syntheticEvent(args: {
    accountPubkey: PublicKey;
    kind: LifecycleEventKind;
    payload?: Uint8Array;
  }): Promise<LifecycleEvent> {
    const m = await this.loadMarket();
    const obligation = await KaminoObligation.load(m, args.accountPubkey);
    if (!obligation) {
      throw new Error(`Kamino obligation ${args.accountPubkey.toBase58()} not found`);
    }
    const collateralDeposits = obligation.deposits;
    const borrows = obligation.borrows;
    const firstCollateral = collateralDeposits.values().next().value;
    const firstBorrow = borrows.values().next().value;
    const position: PositionSnapshot = {
      owner: obligation.state.owner.toBase58(),
      collateralMint: firstCollateral?.mintAddress.toBase58() ?? PublicKey.default.toBase58(),
      debtMint: firstBorrow?.mintAddress.toBase58() ?? PublicKey.default.toBase58(),
      collateralAmount: firstCollateral ? Number(firstCollateral.amount.toString()) : 0,
      debtAmount: firstBorrow ? Number(firstBorrow.amount.toString()) : 0,
      ltvBps: obligation.loanToValue().toNumber() * 10_000,
      liquidationThresholdBps: 8_500,
    };
    const snapshot = await this.snapshotPool(args.accountPubkey);
    return {
      kind: args.kind,
      adapter: "kamino",
      position,
      market: {
        slot: await m.getConnection().getSlot(),
        timestamp: Math.floor(Date.now() / 1000),
        realisedVolBps: 250,
        utilisationBps: snapshot.utilisationBps,
        oraclePoints: [],
      },
      payload: Array.from(args.payload ?? new Uint8Array()),
    };
  }
}

export * from "./types.js";
