import assert from "node:assert/strict";
import test from "node:test";

import {
  TreasuryReviewQueue,
  treasuryAssetKey,
  treasuryDestinationKey,
} from "./treasury.js";

const asset = { chain: "solana", network: "devnet", assetId: "SOL" } as const;
const destination = { chain: "solana", network: "devnet", address: "destination-1" } as const;
const input = { ...asset, ...destination, amount: 60n, rationale: "Reviewed integration test" };
const day = Date.parse("2026-10-05T12:00:00.000Z");

function queue(now = day) {
  return new TreasuryReviewQueue({
    allowedAssets: [treasuryAssetKey(asset)],
    allowedDestinations: [treasuryDestinationKey(destination)],
    maxSingleTransfer: 80n,
    maxDailyTransfer: 100n,
    requireHumanApproval: true,
  }, () => now);
}

test("treasury proposals bind approvals to chain, destination, amount, and rationale", () => {
  const treasury = queue();
  const proposal = treasury.propose(input);
  assert.match(proposal.contentFingerprint, /^[a-f0-9]{64}$/);
  const approved = treasury.review(proposal.id, "approve", "operator:alice");
  assert.equal(approved.reviewFingerprint, proposal.contentFingerprint);
  assert.equal(approved.reviewer, "operator:alice");
  assert.equal(approved.reviewedAt, day);
  assert.throws(() => treasury.review(proposal.id, "approve", "operator:alice"), /not found/);
});

test("pending and approved proposals reserve daily capacity; rejected and cancelled ones release it", () => {
  const treasury = queue();
  const pending = treasury.propose(input);
  assert.throws(() => treasury.propose({ ...input, amount: 41n }), /daily treasury review limit/);
  treasury.cancel(pending.id, "operator:alice", "No longer needed");
  const next = treasury.propose({ ...input, amount: 60n });
  treasury.review(next.id, "reject", "operator:alice");
  assert.doesNotThrow(() => treasury.propose({ ...input, amount: 60n }));
});

test("treasury queue validates runtime chain, integer-unit amount, limits, and reviewer", () => {
  const treasury = queue();
  assert.throws(() => treasury.propose({ ...input, chain: "unknown" as "solana" }), /chain must be/);
  assert.throws(() => treasury.propose({ ...input, amount: 0n }), /positive bigint/);
  assert.throws(() => treasury.propose({ ...input, amount: 81n }), /single-transfer limit/);
  assert.throws(() => treasury.review("missing", "invalid" as "approve", "operator"), /not found/);
  const proposal = treasury.propose(input);
  assert.throws(() => treasury.review(proposal.id, "approve", " "), /identity/);
  assert.throws(() => new TreasuryReviewQueue({
    allowedAssets: [], allowedDestinations: [], maxSingleTransfer: 1n, maxDailyTransfer: 2n, requireHumanApproval: true,
  }), /allowlists/);
});
