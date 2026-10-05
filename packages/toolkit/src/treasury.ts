import { createHash, randomUUID } from "node:crypto";

export type TreasuryChain = "solana" | "bitcoin" | "ethereum";
const MAX_PROPOSALS = 10_000;
const MAX_RATIONALE_LENGTH = 2_000;

export interface TreasuryAsset {
  chain: TreasuryChain;
  /** Explicit cluster/chain, e.g. mainnet-beta, devnet, mainnet, or sepolia. */
  network: string;
  /** Native ticker or token identifier (mint / contract address). */
  assetId: string;
}

export interface TreasuryDestination {
  chain: TreasuryChain;
  network: string;
  address: string;
}

export const treasuryAssetKey = ({ chain, network, assetId }: TreasuryAsset): string =>
  `${chain}:${network}:${assetId}`;

export const treasuryDestinationKey = ({ chain, network, address }: TreasuryDestination): string =>
  `${chain}:${network}:${address}`;

export interface TreasuryPolicy {
  /** Fully-qualified keys from treasuryDestinationKey(). */
  allowedDestinations: readonly string[];
  /** Fully-qualified keys from treasuryAssetKey(). */
  allowedAssets: readonly string[];
  /** Caps are denominated in the asset's smallest indivisible unit. */
  maxSingleTransfer: bigint;
  maxDailyTransfer: bigint;
  requireHumanApproval: true;
}

export interface TreasuryProposal extends TreasuryDestination, TreasuryAsset {
  id: string;
  /** Integer base units (lamports, satoshis, wei, or token base units); never a float. */
  amount: bigint;
  rationale: string;
  createdAt: number;
  status: "pending-review" | "approved" | "rejected" | "cancelled";
  contentFingerprint: string;
  reviewer?: string;
  reviewedAt?: number;
  reviewFingerprint?: string;
  cancellationReason?: string;
}

/**
 * A chain-neutral, in-memory proposal and review ledger. It deliberately has no
 * wallet, key, signing, RPC, or broadcast API. A reviewed proposal still needs
 * chain-specific validation and a separately secured signer before execution.
 */
export class TreasuryReviewQueue {
  private readonly proposals = new Map<string, TreasuryProposal>();
  private readonly policy: TreasuryPolicy;

  constructor(policy: TreasuryPolicy, private readonly clock: () => number = Date.now) {
    if (policy.requireHumanApproval !== true) throw new Error("Human approval must remain enabled");
    if (typeof policy.maxSingleTransfer !== "bigint" || typeof policy.maxDailyTransfer !== "bigint" ||
      policy.maxSingleTransfer <= 0n || policy.maxDailyTransfer <= 0n) {
      throw new Error("Treasury limits must be positive bigint base-unit amounts");
    }
    if (policy.maxSingleTransfer > policy.maxDailyTransfer) {
      throw new Error("Single-transfer limit cannot exceed the daily limit");
    }
    if (policy.allowedAssets.length === 0 || policy.allowedDestinations.length === 0 ||
      [...policy.allowedAssets, ...policy.allowedDestinations].some((key) => !key.trim())) {
      throw new Error("Treasury allowlists must contain non-empty chain-qualified keys");
    }
    this.policy = Object.freeze({
      ...policy,
      allowedAssets: Object.freeze([...new Set(policy.allowedAssets)]),
      allowedDestinations: Object.freeze([...new Set(policy.allowedDestinations)]),
    });
  }

  propose(input: Omit<TreasuryProposal,
    "id" | "createdAt" | "status" | "reviewer" | "reviewedAt" | "contentFingerprint" | "reviewFingerprint" | "cancellationReason">): TreasuryProposal {
    validateChain(input.chain);
    const destinationKey = treasuryDestinationKey(input);
    const assetKey = treasuryAssetKey(input);
    if (!this.policy.allowedDestinations.includes(destinationKey)) throw new Error("Destination is not allowlisted for this chain and network");
    if (!this.policy.allowedAssets.includes(assetKey)) throw new Error("Asset is not allowlisted for this chain and network");
    if (!input.network.trim() || input.network.length > 64 || !input.address.trim() || input.address.length > 256 ||
      !input.assetId.trim() || input.assetId.length > 256) {
      throw new Error("Chain, network, asset, and destination are required and must be bounded");
    }
    if (typeof input.amount !== "bigint" || input.amount <= 0n || input.amount > this.policy.maxSingleTransfer) {
      throw new Error("Amount must be a positive bigint within the single-transfer limit");
    }
    if (!input.rationale.trim() || input.rationale.length > MAX_RATIONALE_LENGTH) {
      throw new Error(`A rationale of 1 to ${MAX_RATIONALE_LENGTH} characters is required`);
    }
    if (this.proposals.size >= MAX_PROPOSALS) throw new Error(`Treasury queue reached its ${MAX_PROPOSALS} proposal capacity`);

    const now = this.now();
    const today = new Date(now).toISOString().slice(0, 10);
    // Base units are incomparable across assets; aggregate daily caps per exact asset.
    const alreadyCommitted = [...this.proposals.values()]
      .filter((proposal) =>
        proposal.status !== "rejected" && proposal.status !== "cancelled" &&
        treasuryAssetKey(proposal) === assetKey &&
        new Date(proposal.createdAt).toISOString().slice(0, 10) === today,
      )
      .reduce((total, proposal) => total + proposal.amount, 0n);
    if (alreadyCommitted + input.amount > this.policy.maxDailyTransfer) throw new Error("Proposal exceeds the daily treasury review limit for this asset");

    const proposal: TreasuryProposal = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      status: "pending-review",
      contentFingerprint: treasuryProposalFingerprint(input),
    };
    this.proposals.set(proposal.id, proposal);
    return structuredClone(proposal);
  }

  review(id: string, decision: "approve" | "reject", reviewer: string): TreasuryProposal {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== "pending-review") throw new Error(`Pending treasury proposal ${id} not found`);
    if (decision !== "approve" && decision !== "reject") throw new Error("Review decision must be approve or reject");
    if (!reviewer.trim()) throw new Error("Reviewer identity is required");
    if (proposal.contentFingerprint !== treasuryProposalFingerprint(proposal)) {
      throw new Error("Treasury proposal content changed after creation");
    }
    proposal.status = decision === "approve" ? "approved" : "rejected";
    proposal.reviewer = reviewer.trim();
    proposal.reviewedAt = this.now();
    proposal.reviewFingerprint = proposal.contentFingerprint;
    return structuredClone(proposal);
  }

  cancel(id: string, actor: string, reason: string): TreasuryProposal {
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.status !== "pending-review") {
      throw new Error(`Pending treasury proposal ${id} not found`);
    }
    if (!actor.trim()) throw new Error("Cancellation actor identity is required");
    if (!reason.trim() || reason.length > MAX_RATIONALE_LENGTH) {
      throw new Error(`Cancellation reason of 1 to ${MAX_RATIONALE_LENGTH} characters is required`);
    }
    proposal.status = "cancelled";
    proposal.reviewer = actor.trim();
    proposal.reviewedAt = this.now();
    proposal.cancellationReason = reason.trim();
    proposal.reviewFingerprint = proposal.contentFingerprint;
    return structuredClone(proposal);
  }

  list(): readonly TreasuryProposal[] {
    return [...this.proposals.values()].map((proposal) => structuredClone(proposal));
  }

  get(id: string): TreasuryProposal | undefined {
    const proposal = this.proposals.get(id);
    return proposal ? structuredClone(proposal) : undefined;
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Treasury clock must return a non-negative safe integer");
    return value;
  }
}

export function treasuryProposalFingerprint(proposal: Pick<TreasuryProposal,
  "chain" | "network" | "assetId" | "address" | "amount" | "rationale">): string {
  const canonical = JSON.stringify({
    chain: proposal.chain,
    network: proposal.network,
    assetId: proposal.assetId,
    address: proposal.address,
    amount: proposal.amount.toString(),
    rationale: proposal.rationale,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function validateChain(chain: string): asserts chain is TreasuryChain {
  if (chain !== "solana" && chain !== "bitcoin" && chain !== "ethereum") {
    throw new Error("Treasury chain must be solana, bitcoin, or ethereum");
  }
}
