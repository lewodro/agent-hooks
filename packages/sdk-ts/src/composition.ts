import type { LifecycleEventKind } from "@agent-hooks/marginfi-adapter";

export interface HookSpec {
  name: string;
  programId: string;
  priority: number;
  flags: HookFlagBits;
  config?: Record<string, unknown>;
}

export interface HookFlagBits {
  bits: number;
}

export const HOOK_FLAGS = {
  BeforeDeposit: 1 << 0,
  AfterDeposit: 1 << 1,
  BeforeBorrow: 1 << 2,
  AfterBorrow: 1 << 3,
  BeforeRepay: 1 << 4,
  AfterRepay: 1 << 5,
  BeforeLiquidate: 1 << 6,
  AfterLiquidate: 1 << 7,
  MutatePayload: 1 << 8,
  MayReject: 1 << 9,
  UsesOracle: 1 << 10,
  MutatesRate: 1 << 11,
} as const;

export const MAX_HOOKS_PER_COMPOSITION = 8;
export const MAX_COMPOSITION_SLOT_INDEX = 7;
export const MAX_HOOK_PRIORITY = 0xffff;
const LIFECYCLE_FLAG_MASK = 0x00ff;
const SUPPORTED_HOOK_FLAG_MASK = 0x0fff;

export type HookFlagName = keyof typeof HOOK_FLAGS;

export function flagsFrom(names: HookFlagName[]): HookFlagBits {
  let bits = 0;
  for (const n of names) bits |= HOOK_FLAGS[n];
  return { bits };
}

export function eventToFlag(kind: LifecycleEventKind): number {
  switch (kind) {
    case "beforeDeposit": return HOOK_FLAGS.BeforeDeposit;
    case "afterDeposit": return HOOK_FLAGS.AfterDeposit;
    case "beforeBorrow": return HOOK_FLAGS.BeforeBorrow;
    case "afterBorrow": return HOOK_FLAGS.AfterBorrow;
    case "beforeRepay": return HOOK_FLAGS.BeforeRepay;
    case "afterRepay": return HOOK_FLAGS.AfterRepay;
    case "beforeLiquidate": return HOOK_FLAGS.BeforeLiquidate;
    case "afterLiquidate": return HOOK_FLAGS.AfterLiquidate;
  }
}

/** Validate the portion of a hook entry serialized into the Anchor registry. */
export function validateHookSpec(spec: HookSpec): void {
  if (!spec.name.trim()) throw new TypeError("hook name must not be empty");
  if (!spec.programId.trim()) throw new TypeError("hook programId must not be empty");
  if (!Number.isSafeInteger(spec.priority) || spec.priority < 0 || spec.priority > MAX_HOOK_PRIORITY) {
    throw new RangeError(`hook priority must be an integer between 0 and ${MAX_HOOK_PRIORITY}`);
  }
  const flags = spec.flags.bits;
  if (!Number.isSafeInteger(flags) || flags < 0 || flags > SUPPORTED_HOOK_FLAG_MASK) {
    throw new RangeError("hook flags contain unsupported bits");
  }
  if ((flags & LIFECYCLE_FLAG_MASK) === 0) {
    throw new TypeError("hook flags must include at least one lifecycle flag");
  }
}

/** The Anchor composition PDA uses one byte for the slot index. */
export function validateCompositionSlotIndex(slotIndex: number): void {
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex > MAX_COMPOSITION_SLOT_INDEX) {
    throw new RangeError(`composition slotIndex must be an integer between 0 and ${MAX_COMPOSITION_SLOT_INDEX}`);
  }
}

export class Composition {
  private entries: HookSpec[] = [];

  add(spec: HookSpec): this {
    if (this.entries.length >= MAX_HOOKS_PER_COMPOSITION) {
      throw new Error(`Composition is full (max ${MAX_HOOKS_PER_COMPOSITION} hooks per pool slot)`);
    }
    validateHookSpec(spec);
    if (this.entries.some((entry) => entry.priority === spec.priority)) {
      throw new Error(`hook priority ${spec.priority} is already used in this composition`);
    }
    this.entries.push({ ...spec, flags: { bits: spec.flags.bits } });
    this.entries.sort((a, b) => a.priority - b.priority);
    return this;
  }

  hooks(): readonly HookSpec[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }

  eligibleFor(kind: LifecycleEventKind): HookSpec[] {
    const bit = eventToFlag(kind);
    return this.entries.filter((e) => (e.flags.bits & bit) !== 0);
  }
}
