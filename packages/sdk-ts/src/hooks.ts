import { type HookSpec, flagsFrom } from "./composition.js";

export interface StandardHookConfig {
  programId: string;
  priority: number;
}

export function dynamicLtv(cfg: StandardHookConfig & {
  baseLtvBps: number;
  sensitivity: number;
  volFloorBps: number;
  minLtvBps: number;
}): HookSpec {
  return {
    name: "DynamicLTV",
    programId: cfg.programId,
    priority: cfg.priority,
    flags: flagsFrom(["BeforeBorrow", "AfterDeposit", "UsesOracle", "MutatePayload"]),
    config: {
      baseLtvBps: cfg.baseLtvBps,
      sensitivity: cfg.sensitivity,
      volFloorBps: cfg.volFloorBps,
      minLtvBps: cfg.minLtvBps,
    },
  };
}

export function timeTriggerLiq(cfg: StandardHookConfig & {
  allowedWindows: Array<{ startSec: number; endSec: number }>;
  maxOracleAgeSlots: number;
  delaySlots: number;
}): HookSpec {
  return {
    name: "TimeTriggerLiq",
    programId: cfg.programId,
    priority: cfg.priority,
    flags: flagsFrom(["BeforeLiquidate", "UsesOracle", "MayReject"]),
    config: {
      allowedWindows: cfg.allowedWindows,
      maxOracleAgeSlots: cfg.maxOracleAgeSlots,
      delaySlots: cfg.delaySlots,
    },
  };
}

export function whitelistBorrow(cfg: StandardHookConfig & {
  allowedOwners: string[];
}): HookSpec {
  return {
    name: "WhitelistBorrow",
    programId: cfg.programId,
    priority: cfg.priority,
    flags: flagsFrom(["BeforeBorrow", "MayReject"]),
    config: { allowedOwners: cfg.allowedOwners },
  };
}

export function antiMevLiq(cfg: StandardHookConfig & {
  minDelaySlots: number;
  keepers?: string[];
}): HookSpec {
  return {
    name: "AntiMEVLiq",
    programId: cfg.programId,
    priority: cfg.priority,
    flags: flagsFrom(["BeforeLiquidate", "MutatePayload", "MayReject"]),
    config: {
      minDelaySlots: cfg.minDelaySlots,
      keepers: cfg.keepers ?? [],
    },
  };
}

export function autoHedge(cfg: StandardHookConfig & {
  triggerPriceE8: bigint;
  hedgeRatioBps: number;
  marketPubkey: string;
}): HookSpec {
  return {
    name: "AutoHedge",
    programId: cfg.programId,
    priority: cfg.priority,
    flags: flagsFrom(["AfterBorrow", "AfterDeposit", "UsesOracle", "MutatePayload"]),
    config: {
      triggerPriceE8: cfg.triggerPriceE8.toString(),
      hedgeRatioBps: cfg.hedgeRatioBps,
      marketPubkey: cfg.marketPubkey,
    },
  };
}

export function reputationRate(cfg: StandardHookConfig & {
  baseRateBps: number;
  maxDiscountBps: number;
  providerProgram: string;
}): HookSpec {
  return {
    name: "ReputationRate",
    programId: cfg.programId,
    priority: cfg.priority,
    flags: flagsFrom(["BeforeBorrow", "MutatesRate"]),
    config: {
      baseRateBps: cfg.baseRateBps,
      maxDiscountBps: cfg.maxDiscountBps,
      providerProgram: cfg.providerProgram,
    },
  };
}

export const STANDARD_HOOK_NAMES = [
  "DynamicLTV",
  "TimeTriggerLiq",
  "WhitelistBorrow",
  "AntiMEVLiq",
  "AutoHedge",
  "ReputationRate",
] as const;
