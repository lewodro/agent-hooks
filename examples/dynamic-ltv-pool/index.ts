import {
  Composition,
  antiMevLiq,
  dynamicLtv,
  simulate,
  type LifecycleEvent,
  type LifecycleEventKind,
} from "@agent-hooks/sdk";

const KINDS: LifecycleEventKind[] = [
  "beforeDeposit",
  "afterDeposit",
  "beforeBorrow",
  "afterBorrow",
  "beforeRepay",
  "afterRepay",
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
      ltvBps: 5_000 + (slot % 30) * 80,
      liquidationThresholdBps: 8_000,
    },
    market: {
      slot,
      timestamp: 1_700_000_000 + slot * 60,
      realisedVolBps: 1_200 + Math.floor(Math.sin(slot / 5) * 800),
      utilisationBps: 6_000,
      oraclePoints: [],
    },
    payload: [],
  };
}

function main() {
  const composition = new Composition()
    .add(dynamicLtv({
      programId: "HookDLTV1111111111111111111111111111111111",
      priority: 10,
      baseLtvBps: 7_500,
      sensitivity: 50,
      volFloorBps: 1_000,
      minLtvBps: 2_500,
    }))
    .add(antiMevLiq({
      programId: "HookAMEV1111111111111111111111111111111111",
      priority: 20,
      minDelaySlots: 3,
    }));

  const events = Array.from({ length: 240 }, (_, i) =>
    fakeEvent(1_000_000 + i, KINDS[i % KINDS.length] ?? "afterDeposit"),
  );
  const report = simulate(composition, events);
  console.log(JSON.stringify({
    eventsReplayed: report.totalEvents,
    ltvOverrides: report.ltvOverrides,
    liquidationsDelayed: report.liquidationsDelayed,
    liquidationsExecuted: report.liquidationsExecuted,
    borrowsRejected: report.borrowsRejected,
  }, null, 2));
}

main();
