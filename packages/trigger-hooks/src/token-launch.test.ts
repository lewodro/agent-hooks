import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PublicKey, type Connection, type Transaction } from "@solana/web3.js";
import { launchApprovedToken } from "./token-launch.js";
import type { TokenLaunchProposal } from "./launch-proposals.js";

const proposal: TokenLaunchProposal = {
  id: "test", name: "Test Coin", symbol: "TEST", decimals: 6, initialSupply: 1_000_000_000n,
  network: "devnet", metadataUri: "https://example.com/token.json", status: "approved",
  fingerprint: "a".repeat(64), createdAt: 1, reviewer: "operator", reviewedAt: 2,
};
proposal.fingerprint = createHash("sha256").update(JSON.stringify({ name: proposal.name, symbol: proposal.symbol, decimals: proposal.decimals, initial_supply: proposal.initialSupply.toString(), network: proposal.network, metadata_uri: proposal.metadataUri })).digest("hex");
proposal.id = proposal.fingerprint;
const confirmation = { async confirm() { return true; } };

test("launch requires human review before it can reach the wallet", async () => {
  const pending = { ...proposal, status: "pending_review" as const };
  await assert.rejects(launchApprovedToken(pending, {} as never, {} as Connection, confirmation), /approved by a named reviewer/);
});

test("approved proposal builds fixed-supply mint transaction and delegates signing to wallet", async () => {
  const walletKey = new PublicKey("11111111111111111111111111111111");
  const calls: Transaction[] = [];
  const wallet = {
    publicKey: walletKey,
    async sendTransaction(transaction: Transaction) { calls.push(transaction); return "signature"; },
  };
  const connection = {
    async getGenesisHash() { return "EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; },
    async getMinimumBalanceForRentExemption() { return 1_461_600; },
    async getLatestBlockhash() { return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 }; },
  } as unknown as Connection;
  const result = await launchApprovedToken(proposal, wallet, connection, confirmation, { confirm: false });
  assert.equal(result.signature, "signature");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.instructions.length, 5);
  assert.equal(calls[0]?.feePayer?.toBase58(), walletKey.toBase58());
});

test("rejects network mismatch before requesting wallet signature", async () => {
  let prompted = false;
  const wallet = { publicKey: new PublicKey("11111111111111111111111111111111"), async sendTransaction() { prompted = true; return ""; } };
  const connection = { async getGenesisHash() { return "wrong-network"; } } as unknown as Connection;
  await assert.rejects(launchApprovedToken(proposal, wallet, connection, confirmation), /not devnet/);
  assert.equal(prompted, false);
});

test("proposal edits invalidate fingerprint and explicit user cancellation stops before RPC", async () => {
  const altered = { ...proposal, name: "Not Reviewed" };
  await assert.rejects(launchApprovedToken(altered, {} as never, {} as Connection, confirmation), /fingerprint/);
  const cancelled = { async confirm() { return false; } };
  await assert.rejects(launchApprovedToken(proposal, {} as never, {} as Connection, cancelled), /cancelled/);
});
