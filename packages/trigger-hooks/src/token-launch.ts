import { createHash } from "node:crypto";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type Commitment } from "@solana/web3.js";
import { validateTokenLaunchRequest, type TokenLaunchProposal } from "./launch-proposals.js";

export interface LaunchWallet {
  publicKey: PublicKey;
  /** Browser wallet adapter's sendTransaction prompts the connected user to sign. */
  sendTransaction(transaction: Transaction, connection: Connection, options: { signers: Keypair[] }): Promise<string>;
}

export interface TokenLaunchResult {
  mintAddress: string;
  tokenAccountAddress: string;
  signature: string;
  explorerUrl: string;
}

export interface TokenLaunchConfirmation {
  /** Render name, symbol, decimals, exact base-unit supply, network, and URI; resolve true only on an explicit user confirmation. */
  confirm(details: Pick<TokenLaunchProposal, "name" | "symbol" | "decimals" | "initialSupply" | "network" | "metadataUri">): Promise<boolean>;
}

/**
 * Creates a fixed-supply classic SPL token from an approved proposal. Call only
 * from an explicit user action in a wallet-connected UI. The connected wallet
 * signs as payer/mint authority; this module never accesses its private key.
 * This v1 creates the mint and initial wallet balance, but does not create a
 * DEX pool or register the proposal's metadata URI on-chain.
 */
export async function launchApprovedToken(
  proposal: TokenLaunchProposal,
  wallet: LaunchWallet,
  connection: Connection,
  confirmation: TokenLaunchConfirmation,
  options: { commitment?: Commitment; confirm?: boolean } = {},
): Promise<TokenLaunchResult> {
  if (proposal.status !== "approved" || !proposal.reviewer || proposal.reviewedAt === null) {
    throw new Error("token launch must be approved by a named reviewer before wallet execution");
  }
  validateTokenLaunchRequest({ name: proposal.name, symbol: proposal.symbol, decimals: proposal.decimals,
    initialSupply: proposal.initialSupply, network: proposal.network, metadataUri: proposal.metadataUri });
  const expectedFingerprint = createHash("sha256").update(JSON.stringify({
    name: proposal.name,
    symbol: proposal.symbol,
    decimals: proposal.decimals,
    initial_supply: proposal.initialSupply.toString(),
    network: proposal.network,
    metadata_uri: proposal.metadataUri,
  })).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(proposal.fingerprint) || proposal.id !== proposal.fingerprint || proposal.fingerprint !== expectedFingerprint) {
    throw new Error("approved proposal fingerprint does not match its launch details");
  }
  if (!await confirmation.confirm({
    name: proposal.name, symbol: proposal.symbol, decimals: proposal.decimals,
    initialSupply: proposal.initialSupply, network: proposal.network, metadataUri: proposal.metadataUri,
  })) throw new Error("user cancelled token launch confirmation");
  if (proposal.network !== "devnet" && proposal.network !== "mainnet-beta") throw new Error("unsupported Solana cluster");
  if (typeof proposal.initialSupply !== "bigint" || proposal.initialSupply <= 0n || proposal.initialSupply > 18_446_744_073_709_551_615n) {
    throw new Error("proposal supply must be an exact positive u64 base-unit amount");
  }
  const genesis = await connection.getGenesisHash();
  const expectedGenesis = proposal.network === "mainnet-beta"
    ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
    : "EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  if (genesis !== expectedGenesis) throw new Error(`connected RPC is not ${proposal.network}`);

  const mint = Keypair.generate();
  const tokenAccount = getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const rent = await getMinimumBalanceForRentExemptMint(connection);
  const transaction = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey, newAccountPubkey: mint.publicKey, lamports: rent,
      space: 82, programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mint.publicKey, proposal.decimals, wallet.publicKey, null, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(wallet.publicKey, tokenAccount, wallet.publicKey, mint.publicKey, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, tokenAccount, wallet.publicKey, proposal.initialSupply, [], TOKEN_PROGRAM_ID),
    createSetAuthorityInstruction(mint.publicKey, wallet.publicKey, AuthorityType.MintTokens, null, [], TOKEN_PROGRAM_ID),
  );
  const latest = await connection.getLatestBlockhash(options.commitment ?? "confirmed");
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = latest.blockhash;
  const signature = await wallet.sendTransaction(transaction, connection, { signers: [mint] });
  if (options.confirm !== false) {
    const confirmation = await connection.confirmTransaction({ signature, ...latest }, options.commitment ?? "confirmed");
    if (confirmation.value.err) throw new Error(`token launch transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  const cluster = proposal.network === "devnet" ? "devnet" : "mainnet-beta";
  return {
    mintAddress: mint.publicKey.toBase58(), tokenAccountAddress: tokenAccount.toBase58(), signature,
    explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`,
  };
}
