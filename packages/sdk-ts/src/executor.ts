import {
  AnchorProvider,
  Program,
  type Idl,
  utils,
} from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type Signer,
} from "@solana/web3.js";

import type { Composition } from "./composition.js";

/** Placeholder only. Supply the deployed executor ID explicitly in production. */
export const DEFAULT_AGENT_HOOKS_EXECUTOR_ID = PublicKey.default;

export interface ExecutorClientOptions {
  rpcEndpoint: string;
  payer: Signer;
  idl: Idl;
  programId?: PublicKey;
}

const ADAPTER_BYTE = {
  marginfi: 0,
  kamino: 1,
  solend: 2,
} as const;

export type AdapterName = keyof typeof ADAPTER_BYTE;

export class ExecutorClient {
  readonly program: Program;
  readonly provider: AnchorProvider;
  readonly programId: PublicKey;

  constructor(opts: ExecutorClientOptions) {
    const connection = new Connection(opts.rpcEndpoint, "confirmed");
    const wallet = {
      publicKey: opts.payer.publicKey,
      signTransaction: async <T extends { partialSign: (k: Keypair) => void }>(tx: T) => {
        tx.partialSign(opts.payer as Keypair);
        return tx;
      },
      signAllTransactions: async <T extends { partialSign: (k: Keypair) => void }>(txs: T[]) => {
        for (const tx of txs) tx.partialSign(opts.payer as Keypair);
        return txs;
      },
      payer: opts.payer as Keypair,
    };
    this.provider = new AnchorProvider(connection, wallet as never, {
      commitment: "confirmed",
    });
    this.programId = opts.programId ?? DEFAULT_AGENT_HOOKS_EXECUTOR_ID;
    this.program = new Program(opts.idl, this.programId, this.provider);
  }

  poolPda(market: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), market.toBuffer()],
      this.programId,
    );
  }

  compositionPda(pool: PublicKey, slotIndex: number): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("composition"), pool.toBuffer(), Buffer.from([slotIndex])],
      this.programId,
    );
  }

  listingPda(hookProgram: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), hookProgram.toBuffer()],
      this.programId,
    );
  }

  async registerPool(args: {
    market: PublicKey;
    adapter: AdapterName;
    authority: PublicKey;
  }): Promise<string> {
    const [pool, bump] = this.poolPda(args.market);
    const tx = await this.program.methods
      .registerPool(ADAPTER_BYTE[args.adapter], bump)
      .accounts({
        pool,
        market: args.market,
        authority: args.authority,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return tx;
  }

  async installComposition(args: {
    market: PublicKey;
    authority: PublicKey;
    slotIndex: number;
    composition: Composition;
  }): Promise<string> {
    const [pool] = this.poolPda(args.market);
    const [composition] = this.compositionPda(pool, args.slotIndex);
    const entries = args.composition.hooks().map((h) => ({
      hookProgram: new PublicKey(h.programId),
      priority: h.priority,
      flags: { bits: h.flags.bits },
    }));
    const tx = await this.program.methods
      .installComposition(args.slotIndex, entries)
      .accounts({
        pool,
        composition,
        authority: args.authority,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return tx;
  }

  encodePayload(payload: Uint8Array): Buffer {
    return Buffer.from(payload);
  }
}

// Lightweight discriminator helper used by integration tests.
export function ixDiscriminator(name: string): Buffer {
  return Buffer.from(utils.sha256.hash(`global:${name}`)).slice(0, 8);
}
