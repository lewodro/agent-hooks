import type {
  LifecycleEvent,
  LifecycleEventKind,
  MarketSnapshot,
  PositionSnapshot,
} from "@agent-hooks/marginfi-adapter";

import { eventToFlag, type Composition, type HookSpec } from "./composition.js";

export interface TraceEntry {
  hookName: string;
  outcome: "skipped" | "accepted" | "accepted-with" | "rejected";
  sideEffect?: SideEffect;
  reason?: string;
}

export type SideEffect =
  | { kind: "override-max-ltv-bps"; value: number }
  | { kind: "override-rate-bps"; value: number }
  | { kind: "delay-liquidation-slots"; slots: number }
  | { kind: "emit-instruction"; instruction: string; payloadBytes: number };

export interface BacktestReport {
  totalEvents: number;
  liquidationsExecuted: number;
  liquidationsDelayed: number;
  borrowsRejected: number;
  rateOverrides: number;
  ltvOverrides: number;
  realisedPnlE8: bigint;
  steps: Array<{
    slot: number;
    kind: LifecycleEventKind;
    entries: TraceEntry[];
    rejected: string | null;
  }>;
}

/**
 * Deterministic in-memory simulator. Mirrors the behaviour of the on-chain
 * executor's `run_composition` without round-tripping to Solana. Used by the
 * web Hook Designer and the CLI's `agent-hooks simulate` command.
 */
export function simulate(composition: Composition, events: LifecycleEvent[]): BacktestReport {
  const report: BacktestReport = {
    totalEvents: events.length,
    liquidationsExecuted: 0,
    liquidationsDelayed: 0,
    borrowsRejected: 0,
    rateOverrides: 0,
    ltvOverrides: 0,
    realisedPnlE8: 0n,
    steps: [],
  };

  for (const event of events) {
    const eligibleBit = eventToFlag(event.kind);
    const entries: TraceEntry[] = [];
    let rejected: string | null = null;

    for (const hook of composition.hooks()) {
      if ((hook.flags.bits & eligibleBit) === 0) {
        entries.push({ hookName: hook.name, outcome: "skipped" });
        continue;
      }
      const decision = decideForHook(hook, event);
      if (decision.outcome === "rejected") {
        entries.push({
          hookName: hook.name,
          outcome: "rejected",
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        });
        rejected = decision.reason ?? `${hook.name} rejected the event`;
        if (event.kind === "beforeBorrow") report.borrowsRejected += 1;
        break;
      }
      entries.push({
        hookName: hook.name,
        outcome: decision.sideEffect ? "accepted-with" : "accepted",
        ...(decision.sideEffect === undefined ? {} : { sideEffect: decision.sideEffect }),
      });
      if (decision.sideEffect) {
        if (decision.sideEffect.kind === "override-max-ltv-bps") report.ltvOverrides += 1;
        if (decision.sideEffect.kind === "override-rate-bps") report.rateOverrides += 1;
        if (decision.sideEffect.kind === "delay-liquidation-slots")
          report.liquidationsDelayed += 1;
      }
    }

    if (event.kind === "afterLiquidate" && !rejected) report.liquidationsExecuted += 1;
    report.realisedPnlE8 += BigInt(
      event.position.collateralAmount - event.position.debtAmount,
    );
    report.steps.push({
      slot: event.market.slot,
      kind: event.kind,
      entries,
      rejected,
    });
  }

  return report;
}

interface Decision {
  outcome: "accepted" | "rejected";
  sideEffect?: SideEffect;
  reason?: string;
}

function decideForHook(hook: HookSpec, event: LifecycleEvent): Decision {
  const cfg = hook.config ?? {};
  switch (hook.name) {
    case "DynamicLTV":
      return decideDynamicLtv(cfg, event.position, event.market);
    case "TimeTriggerLiq":
      return decideTimeTriggerLiq(cfg, event.market);
    case "WhitelistBorrow":
      return decideWhitelistBorrow(cfg, event.position);
    case "AntiMEVLiq":
      return decideAntiMev(cfg, event);
    case "AutoHedge":
      return decideAutoHedge(cfg, event.position, event.market);
    case "ReputationRate":
      return decideReputationRate(cfg, event.position);
    default:
      return { outcome: "accepted" };
  }
}

function decideDynamicLtv(cfg: Record<string, unknown>, position: PositionSnapshot, market: MarketSnapshot): Decision {
  const base = Number(cfg.baseLtvBps ?? 7500);
  const sens = Number(cfg.sensitivity ?? 50);
  const floor = Number(cfg.volFloorBps ?? 1000);
  const min = Number(cfg.minLtvBps ?? 2500);
  const excess = Math.max(0, market.realisedVolBps - floor);
  const drop = Math.floor(excess / 100) * sens;
  const target = Math.max(min, base - drop);
  if (position.ltvBps > target) {
    return { outcome: "rejected", reason: `DynamicLTV cap ${target} bps vs position ${position.ltvBps} bps` };
  }
  return { outcome: "accepted", sideEffect: { kind: "override-max-ltv-bps", value: target } };
}

function decideTimeTriggerLiq(cfg: Record<string, unknown>, market: MarketSnapshot): Decision {
  const windows = (cfg.allowedWindows as Array<{ startSec: number; endSec: number }>) ?? [];
  const maxAge = Number(cfg.maxOracleAgeSlots ?? 500);
  const delay = Number(cfg.delaySlots ?? 300);
  const stale = market.oraclePoints.some((p) => BigInt(market.slot) - p.slot > BigInt(maxAge));
  if (stale) return { outcome: "accepted", sideEffect: { kind: "delay-liquidation-slots", slots: delay } };
  if (windows.length === 0) return { outcome: "accepted" };
  const seconds = ((market.timestamp % 86_400) + 86_400) % 86_400;
  const hit = windows.find((w) => seconds >= w.startSec && seconds < w.endSec);
  if (!hit) return { outcome: "rejected", reason: "TimeTriggerLiq: outside allowed window" };
  return { outcome: "accepted" };
}

function decideWhitelistBorrow(cfg: Record<string, unknown>, position: PositionSnapshot): Decision {
  const allowed = (cfg.allowedOwners as string[]) ?? [];
  if (allowed.includes(position.owner)) return { outcome: "accepted" };
  return { outcome: "rejected", reason: "WhitelistBorrow: borrower not on allowlist" };
}

function decideAntiMev(cfg: Record<string, unknown>, event: LifecycleEvent): Decision {
  const delay = Number(cfg.minDelaySlots ?? 3);
  const keepers = (cfg.keepers as string[]) ?? [];
  if (keepers.length > 0) {
    const caller = event.payload.length >= 32
      ? Buffer.from(event.payload.slice(0, 32)).toString("hex")
      : "";
    if (!keepers.includes(caller)) {
      return { outcome: "rejected", reason: "AntiMEVLiq: caller not a registered keeper" };
    }
  }
  return { outcome: "accepted", sideEffect: { kind: "delay-liquidation-slots", slots: delay } };
}

function decideAutoHedge(cfg: Record<string, unknown>, position: PositionSnapshot, market: MarketSnapshot): Decision {
  const trigger = BigInt(String(cfg.triggerPriceE8 ?? "0"));
  const ratio = Number(cfg.hedgeRatioBps ?? 5000);
  const point = market.oraclePoints.find((p) => Buffer.from(p.mint).toString("hex") === position.collateralMint);
  if (!point) return { outcome: "accepted" };
  if (point.priceE8 >= trigger) return { outcome: "accepted" };
  return {
    outcome: "accepted",
    sideEffect: {
      kind: "emit-instruction",
      instruction: "drift-short",
      payloadBytes: 80,
    },
  };
}

function decideReputationRate(cfg: Record<string, unknown>, _position: PositionSnapshot): Decision {
  const base = Number(cfg.baseRateBps ?? 1200);
  const maxDiscount = Number(cfg.maxDiscountBps ?? 600);
  const score = 6_000; // simulator default — production reads from provider PDA
  const discount = Math.floor((maxDiscount * score) / 10_000);
  const rate = Math.max(0, base - discount);
  return { outcome: "accepted", sideEffect: { kind: "override-rate-bps", value: rate } };
}
