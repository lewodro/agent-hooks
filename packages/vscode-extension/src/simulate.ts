import {
  Composition,
  dynamicLtv,
  reputationRate,
  simulate,
  type LifecycleEvent,
  type LifecycleEventKind,
} from "@agent-hooks/sdk";

const KINDS: LifecycleEventKind[] = [
  "beforeDeposit",
  "afterDeposit",
  "beforeBorrow",
  "afterBorrow",
  "beforeLiquidate",
  "afterLiquidate",
];

function fakeEvent(slot: number, kind: LifecycleEventKind): LifecycleEvent {
  return {
    kind,
    adapter: "marginfi",
    position: {
      owner: "Br0wer11111111111111111111111111111111111111",
      collateralMint: "So11111111111111111111111111111111111111112",
      debtMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      collateralAmount: 1_000_000_000,
      debtAmount: 500_000_000,
      ltvBps: 5_000,
      liquidationThresholdBps: 8_000,
    },
    market: {
      slot: BigInt(slot),
      timestamp: 40_000,
      realisedVolBps: 1_200 + Math.floor(Math.sin(slot / 5) * 800),
      utilisationBps: 6_000,
      oraclePoints: [],
    },
    payload: [],
  };
}

export function runSimulation(opts: { pool: string; steps: number }) {
  const composition = new Composition()
    .add(dynamicLtv({
      programId: "HookDLTV1111111111111111111111111111111111",
      priority: 10,
      baseLtvBps: 7_500,
      sensitivity: 50,
      volFloorBps: 1_000,
      minLtvBps: 2_500,
    }))
    .add(reputationRate({
      programId: "HookRepRt1111111111111111111111111111111111",
      priority: 20,
      baseRateBps: 1_200,
      maxDiscountBps: 600,
      providerProgram: "RepuProvider1111111111111111111111111111111",
    }));
  const events: LifecycleEvent[] = Array.from({ length: opts.steps }, (_, i) =>
    fakeEvent(1_000_000 + i, KINDS[i % KINDS.length] ?? "afterDeposit"),
  );
  return simulate(composition, events);
}
