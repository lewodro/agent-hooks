import { Connection, PublicKey } from "@solana/web3.js";
import {
  MarginfiClient,
  getConfig,
  MarginRequirementType,
  PriceBias,
  type Environment,
} from "@mrgnlabs/marginfi-client-v2";
import { NodeWallet } from "@mrgnlabs/mrgn-common";
import { computeUtilisationBps } from "@agent-hooks/adapter-core";

import type {
  LendingAdapter,
  LifecycleEvent,
  LifecycleEventKind,
  PoolSnapshot,
  PositionSnapshot,
} from "@agent-hooks/adapter-core";

export const MARGINFI_PROGRAM_ID = new PublicKey(
  "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
);

export interface MarginfiAdapterOptions {
  rpcEndpoint: string;
  cluster?: Environment;
  wallet?: NodeWallet;
}

/**
 * Translates Marginfi v2 group/bank state into the runtime-agnostic
 * `PoolSnapshot` and `PositionSnapshot` shapes consumed by the Agent Hooks executor.
 *
 * The adapter is read-only — it never signs transactions. Operators wire
 * their own signer when they pass the produced events into the executor.
 */
export class MarginfiAdapter implements LendingAdapter {
  public readonly kind = "marginfi" as const;
  private readonly options: MarginfiAdapterOptions;
  private client: MarginfiClient | null = null;

  constructor(options: MarginfiAdapterOptions) {
    this.options = options;
  }

  async connect(): Promise<MarginfiClient> {
    if (this.client) return this.client;
    const connection = new Connection(this.options.rpcEndpoint, "confirmed");
    const config = getConfig(this.options.cluster ?? "production");
    const wallet =
      this.options.wallet ?? NodeWallet.local();
    this.client = await MarginfiClient.fetch(config, wallet, connection);
    return this.client;
  }

  programId(): PublicKey {
    return MARGINFI_PROGRAM_ID;
  }

  async snapshotPool(groupPubkey: PublicKey): Promise<PoolSnapshot> {
    const client = await this.connect();
    const banks = client.banks;
    const totalAssets = Array.from(banks.values()).reduce(
      (acc, bank) => {
        const oraclePrice = client.getOraclePriceByBank(bank.address);
        return oraclePrice
          ? acc + bank.computeAssetUsdValue(
              oraclePrice,
              bank.totalAssetShares,
              MarginRequirementType.Equity,
              PriceBias.None,
            ).toNumber()
          : acc;
      },
      0,
    );
    const totalLiabilities = Array.from(banks.values()).reduce(
      (acc, bank) => {
        const oraclePrice = client.getOraclePriceByBank(bank.address);
        return oraclePrice
          ? acc + bank.computeLiabilityUsdValue(
              oraclePrice,
              bank.totalLiabilityShares,
              MarginRequirementType.Equity,
              PriceBias.None,
            ).toNumber()
          : acc;
      },
      0,
    );
    return {
      adapter: "marginfi",
      market: groupPubkey,
      totalAssetsUsd: totalAssets,
      totalLiabilitiesUsd: totalLiabilities,
      utilisationBps: computeUtilisationBps(totalAssets, totalLiabilities),
      reserves: Array.from(banks.entries()).map(([_, bank]) => ({
        mint: bank.mint.toBase58(),
        symbol: bank.tokenSymbol ?? bank.mint.toBase58().slice(0, 4),
        depositApyBps: Math.round(bank.computeInterestRates().lendingRate.toNumber() * 10_000),
        borrowApyBps: Math.round(bank.computeInterestRates().borrowingRate.toNumber() * 10_000),
      })),
    };
  }

  /**
   * Produces a synthetic LifecycleEvent for simulation. In production the
   * executor receives this from Marginfi's onchain CPI; here we wrap an
   * existing `MarginfiAccount` for backtesting.
   */
  async syntheticEvent(args: {
    accountPubkey: PublicKey;
    kind: LifecycleEventKind;
    payload?: Uint8Array;
  }): Promise<LifecycleEvent> {
    const client = await this.connect();
    const [account] = await client.getMultipleMarginfiAccounts([args.accountPubkey]);
    if (!account) throw new Error(`Marginfi account ${args.accountPubkey.toBase58()} not found`);
    const balances = account.activeBalances;
    const collateral = balances.find((b) => b.assetShares.gt(0));
    const debt = balances.find((b) => b.liabilityShares.gt(0));
    const collateralBank = collateral ? client.banks.get(collateral.bankPk.toBase58()) : undefined;
    const debtBank = debt ? client.banks.get(debt.bankPk.toBase58()) : undefined;
    const health = account.computeHealthComponents(MarginRequirementType.Maintenance);
    const slot = await client.provider.connection.getSlot();
    const position: PositionSnapshot = {
      owner: account.authority.toBase58(),
      collateralMint: collateralBank?.mint.toBase58() ?? PublicKey.default.toBase58(),
      debtMint: debtBank?.mint.toBase58() ?? PublicKey.default.toBase58(),
      collateralAmount: collateral && collateralBank
        ? collateral.computeQuantity(collateralBank).assets.toNumber()
        : 0,
      debtAmount: debt && debtBank
        ? debt.computeQuantity(debtBank).liabilities.toNumber()
        : 0,
      ltvBps: health.assets.gt(0)
        ? Math.round((health.liabilities.toNumber() / health.assets.toNumber()) * 10_000)
        : 0,
      liquidationThresholdBps: 8_000,
    };
    const snapshot = await this.snapshotPool(client.group.address);
    return {
      kind: args.kind,
      adapter: "marginfi",
      position,
      market: {
        slot,
        timestamp: Math.floor(Date.now() / 1000),
        realisedVolBps: 200,
        utilisationBps: snapshot.utilisationBps,
        oraclePoints: Array.from(client.oraclePrices.entries()).flatMap(([bankAddress, price]) => {
          const bank = client.banks.get(bankAddress);
          if (!bank) return [];
          return [{
            mint: bank.mint.toBase58(),
            priceE8: BigInt(Math.round(price.priceRealtime.price.toNumber() * 1e8)),
            confidenceE8: BigInt(Math.round(price.priceRealtime.confidence.toNumber() * 1e8)),
            slot: BigInt(slot),
          }];
        }),
      },
      payload: Array.from(args.payload ?? new Uint8Array()),
    };
  }
}

export * from "@agent-hooks/adapter-core";
