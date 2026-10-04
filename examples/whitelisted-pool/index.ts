import {
  Composition,
  reputationRate,
  simulate,
  whitelistBorrow,
  type LifecycleEvent,
} from "@agent-hooks/sdk";

const ALLOWLIST = [
  "InstAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "InstBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
];

function evt(owner: string, slot: number): LifecycleEvent {
  return {
    kind: "beforeBorrow",
    adapter: "solend",
    position: {
      owner,
      collateralMint: "So11111111111111111111111111111111111111112",
      debtMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      collateralAmount: 5_000_000_000,
      debtAmount: 0,
      ltvBps: 0,
      liquidationThresholdBps: 8_000,
    },
    market: {
      slot,
      timestamp: 1_700_000_000 + slot * 60,
      realisedVolBps: 400,
      utilisationBps: 5_400,
      oraclePoints: [],
    },
    payload: [],
  };
}

function main() {
  const composition = new Composition()
    .add(whitelistBorrow({
      programId: "HookWLBR1111111111111111111111111111111111",
      priority: 5,
      allowedOwners: ALLOWLIST,
    }))
    .add(reputationRate({
      programId: "HookRepRt1111111111111111111111111111111111",
      priority: 10,
      baseRateBps: 1_200,
      maxDiscountBps: 600,
      providerProgram: "RepuProvider1111111111111111111111111111111",
    }));

  const events: LifecycleEvent[] = [
    evt(ALLOWLIST[0]!, 1_000_000),
    evt(ALLOWLIST[1]!, 1_000_001),
    evt("StraNger1111111111111111111111111111111111", 1_000_002),
  ];
  const report = simulate(composition, events);
  console.log(JSON.stringify({
    borrowsRejected: report.borrowsRejected,
    rateOverrides: report.rateOverrides,
    steps: report.steps.map((s) => ({ kind: s.kind, rejected: s.rejected, entries: s.entries.length })),
  }, null, 2));
}

main();
