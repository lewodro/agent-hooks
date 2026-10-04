import { Connection, PublicKey } from "@solana/web3.js";
import { SolendMarket, SOLEND_PRODUCTION_PROGRAM_ID } from "@solendprotocol/solend-sdk";

import type {
  LendingAdapter,
  LifecycleEvent,
  LifecycleEventKind,
  PoolSnapshot,
  PositionSnapshot,
  ReserveSnapshot,
} from "./types.js";

export const SOLEND_PROGRAM_ID = new PublicKey(SOLEND_PRODUCTION_PROGRAM_ID);

export interface SolendAdapterOptions {
  rpcEndpoint: string;
  marketAddress?: PublicKey;
}

export class SolendAdapter implements LendingAdapter {
  public readonly kind = "solend" as const;
  private readonly options: SolendAdapterOptions;
  private market: SolendMarket | null = null;

  constructor(options: SolendAdapterOptions) {
    this.options = options;
  }

  programId(): PublicKey {
    return SOLEND_PROGRAM_ID;
  }

  async loadMarket(): Promise<SolendMarket> {
    if (this.market) return this.market;
    const connection = new Connection(this.options.rpcEndpoint, "confirmed");
    const market = await SolendMarket.initialize(connection, "production");
    await market.loadAll();
    this.market = market;
    return market;
  }

  async snapshotPool(market: PublicKey): Promise<PoolSnapshot> {
    const m = await this.loadMarket();
    const reserves: ReserveSnapshot[] = [];
    let totalAssets = 0;
    let totalLiabilities = 0;
    for (const reserve of m.reserves) {
      const stats = reserve.stats;
      if (!stats) continue;
      const assets = Number(stats.totalDepositsWads) / 1e18;
      const liabilities = Number(stats.totalBorrowsWads) / 1e18;
      totalAssets += assets;
      totalLiabilities += liabilities;
      reserves.push({
        mint: reserve.config.liquidityToken.mint,
        symbol: reserve.config.liquidityToken.symbol,
        depositApyBps: Math.round(stats.supplyInterestAPY * 10_000),
        borrowApyBps: Math.round(stats.borrowInterestAPY * 10_000),
      });
    }
    return {
      adapter: "solend",
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
    const obligation = await m.fetchObligationByWallet(args.accountPubkey);
    if (!obligation) {
      throw new Error(`Solend obligation for ${args.accountPubkey.toBase58()} not found`);
    }
    const firstDeposit = obligation.deposits[0];
    const firstBorrow = obligation.borrows[0];
    const position: PositionSnapshot = {
      owner: args.accountPubkey.toBase58(),
      collateralMint: firstDeposit?.mintAddress ?? PublicKey.default.toBase58(),
      debtMint: firstBorrow?.mintAddress ?? PublicKey.default.toBase58(),
      collateralAmount: firstDeposit ? firstDeposit.amount : 0,
      debtAmount: firstBorrow ? firstBorrow.amount : 0,
      ltvBps: Math.round(obligation.totalBorrowValue / Math.max(1, obligation.totalSupplyValue) * 10_000),
      liquidationThresholdBps: 8_500,
    };
    const snapshot = await this.snapshotPool(args.accountPubkey);
    return {
      kind: args.kind,
      adapter: "solend",
      position,
      market: {
        slot: await m.connection.getSlot(),
        timestamp: Math.floor(Date.now() / 1000),
        realisedVolBps: 300,
        utilisationBps: snapshot.utilisationBps,
        oraclePoints: [],
      },
      payload: Array.from(args.payload ?? new Uint8Array()),
    };
  }
}

export * from "./types.js";
