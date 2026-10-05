import { Connection, PublicKey } from "@solana/web3.js";
import {
  fetchObligationsOfPoolByWallet,
  formatObligation,
  getReservesOfPool,
  SOLEND_PRODUCTION_PROGRAM_ID,
} from "@solendprotocol/solend-sdk";
import { computeUtilisationBps } from "@agent-hooks/adapter-core";

import type {
  LendingAdapter,
  LifecycleEvent,
  LifecycleEventKind,
  PoolSnapshot,
  PositionSnapshot,
  ReserveSnapshot,
} from "@agent-hooks/adapter-core";

export const SOLEND_PROGRAM_ID = new PublicKey(SOLEND_PRODUCTION_PROGRAM_ID);

export interface SolendAdapterOptions {
  rpcEndpoint: string;
  marketAddress?: PublicKey;
}

export class SolendAdapter implements LendingAdapter {
  public readonly kind = "solend" as const;
  private readonly options: SolendAdapterOptions;

  constructor(options: SolendAdapterOptions) {
    this.options = options;
  }

  programId(): PublicKey {
    return SOLEND_PROGRAM_ID;
  }

  async snapshotPool(market: PublicKey): Promise<PoolSnapshot> {
    const connection = new Connection(this.options.rpcEndpoint, "confirmed");
    const reserves = await getReservesOfPool(
      market,
      connection,
      SOLEND_PROGRAM_ID.toBase58(),
      await connection.getSlot(),
    );
    const totalAssets = reserves.reduce((sum, reserve) => sum + reserve.totalSupplyUsd.toNumber(), 0);
    const totalLiabilities = reserves.reduce((sum, reserve) => sum + reserve.totalBorrowUsd.toNumber(), 0);
    const reserveSnapshots: ReserveSnapshot[] = reserves.map((reserve) => ({
      mint: reserve.mintAddress,
      symbol: reserve.symbol,
      depositApyBps: Math.round(reserve.supplyInterest.toNumber() * 10_000),
      borrowApyBps: Math.round(reserve.borrowInterest.toNumber() * 10_000),
    }));
    return {
      adapter: "solend",
      market,
      totalAssetsUsd: totalAssets,
      totalLiabilitiesUsd: totalLiabilities,
      utilisationBps: computeUtilisationBps(totalAssets, totalLiabilities),
      reserves: reserveSnapshots,
    };
  }

  async syntheticEvent(args: {
    accountPubkey: PublicKey;
    kind: LifecycleEventKind;
    payload?: Uint8Array;
  }): Promise<LifecycleEvent> {
    const market = this.options.marketAddress;
    if (!market) throw new Error("SolendAdapter requires marketAddress to read an obligation");
    const connection = new Connection(this.options.rpcEndpoint, "confirmed");
    const slot = await connection.getSlot();
    const reserves = await getReservesOfPool(
      market,
      connection,
      SOLEND_PROGRAM_ID.toBase58(),
      slot,
    );
    const obligations = await fetchObligationsOfPoolByWallet(
      args.accountPubkey,
      market,
      SOLEND_PROGRAM_ID,
      connection,
    );
    const rawObligation = obligations[0];
    if (!rawObligation) {
      throw new Error(`Solend obligation for ${args.accountPubkey.toBase58()} not found`);
    }
    const reserveMap = Object.fromEntries(reserves.map((reserve) => [reserve.address, reserve]));
    const obligation = formatObligation(rawObligation, reserveMap);
    const firstDeposit = obligation.deposits[0];
    const firstBorrow = obligation.borrows[0];
    const position: PositionSnapshot = {
      owner: args.accountPubkey.toBase58(),
      collateralMint: firstDeposit?.mintAddress ?? PublicKey.default.toBase58(),
      debtMint: firstBorrow?.mintAddress ?? PublicKey.default.toBase58(),
      collateralAmount: firstDeposit?.amount.toNumber() ?? 0,
      debtAmount: firstBorrow?.amount.toNumber() ?? 0,
      ltvBps: Math.round(
        (obligation.totalBorrowValue.toNumber() / Math.max(1, obligation.totalSupplyValue.toNumber())) * 10_000,
      ),
      liquidationThresholdBps: 8_500,
    };
    const snapshot = await this.snapshotPool(market);
    return {
      kind: args.kind,
      adapter: "solend",
      position,
      market: {
        slot: BigInt(slot),
        timestamp: Math.floor(Date.now() / 1000),
        realisedVolBps: 300,
        utilisationBps: snapshot.utilisationBps,
        oraclePoints: reserves.map((reserve) => ({
          mint: reserve.mintAddress,
          priceE8: BigInt(Math.round(reserve.price.toNumber() * 1e8)),
          confidenceE8: 0n,
          slot: BigInt(slot),
        })),
      },
      payload: Array.from(args.payload ?? new Uint8Array()),
    };
  }
}

export * from "@agent-hooks/adapter-core";
