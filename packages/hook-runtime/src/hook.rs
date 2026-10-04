//! Hook trait and supporting types.

use bytemuck::{Pod, Zeroable};
use serde::{Deserialize, Serialize};

use crate::event::{LifecycleEvent, LifecycleEventKind};

/// Bitmask flags published by a hook at install time. Mirrors Uniswap v4's hook flag layout,
/// but stored in a PDA rather than encoded in the program address — Solana addresses are
/// ed25519-derived, so flag-in-address would force every hook to brute-force keypairs.
#[repr(u16)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HookFlag {
    BeforeDeposit = 1 << 0,
    AfterDeposit = 1 << 1,
    BeforeBorrow = 1 << 2,
    AfterBorrow = 1 << 3,
    BeforeRepay = 1 << 4,
    AfterRepay = 1 << 5,
    BeforeLiquidate = 1 << 6,
    AfterLiquidate = 1 << 7,
    /// May mutate the action payload (similar to delta-return flags in Uniswap v4).
    MutatePayload = 1 << 8,
    /// May reject the action entirely.
    MayReject = 1 << 9,
    /// Reads off-chain oracle data through the runtime adapter.
    UsesOracle = 1 << 10,
    /// Mutates the position's interest rate accrual.
    MutatesRate = 1 << 11,
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, Pod, Zeroable, Serialize, Deserialize)]
pub struct HookFlags(pub u16);

impl HookFlags {
    pub const fn empty() -> Self {
        Self(0)
    }

    pub fn with(mut self, flag: HookFlag) -> Self {
        self.0 |= flag as u16;
        self
    }

    pub fn contains(self, flag: HookFlag) -> bool {
        (self.0 & flag as u16) != 0
    }

    pub fn matches_event(self, kind: LifecycleEventKind) -> bool {
        let needed = match kind {
            LifecycleEventKind::BeforeDeposit => HookFlag::BeforeDeposit,
            LifecycleEventKind::AfterDeposit => HookFlag::AfterDeposit,
            LifecycleEventKind::BeforeBorrow => HookFlag::BeforeBorrow,
            LifecycleEventKind::AfterBorrow => HookFlag::AfterBorrow,
            LifecycleEventKind::BeforeRepay => HookFlag::BeforeRepay,
            LifecycleEventKind::AfterRepay => HookFlag::AfterRepay,
            LifecycleEventKind::BeforeLiquidate => HookFlag::BeforeLiquidate,
            LifecycleEventKind::AfterLiquidate => HookFlag::AfterLiquidate,
        };
        self.contains(needed)
    }
}

/// What a hook returns to the runtime after processing an event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HookDecision {
    /// Accept the event unchanged. Most hooks return this for `after*` phases.
    Accept,
    /// Accept but record a side-effect for the host to apply (e.g. new LTV cap).
    AcceptWith(SideEffect),
    /// Reject the event with a reason. Halts the lifecycle.
    Reject(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SideEffect {
    /// Override the position's max LTV (basis points). Used by DynamicLTV.
    OverrideMaxLtvBps(u16),
    /// Override the interest rate (basis points per year). Used by ReputationRate.
    OverrideRateBps(u16),
    /// Delay the liquidation by N slots. Used by TimeTriggerLiq / AntiMEVLiq.
    DelayLiquidationSlots(u64),
    /// Emit a follow-on instruction (CPI handle) that the host must include.
    EmitInstruction { kind: InstructionKind, payload: Vec<u8> },
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum InstructionKind {
    DriftShort,
    JupiterSwap,
    Custom,
}

/// Metadata stored alongside a registered hook.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HookMeta {
    pub name: String,
    pub version: String,
    pub author: String,
    pub flags: HookFlags,
    pub description: String,
}

/// Information passed to every hook invocation. Read-only.
#[derive(Clone, Debug)]
pub struct HookContext<'a> {
    pub event: &'a LifecycleEvent,
    pub composition_index: usize,
    pub composition_total: usize,
}

/// The trait that every hook implements.
///
/// In production, hooks are deployed as separate Solana programs and the runtime CPIs
/// into them. In simulation / unit tests we use this trait directly.
pub trait Hook: Send + Sync {
    fn meta(&self) -> &HookMeta;
    fn evaluate(&self, ctx: &HookContext<'_>) -> HookDecision;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_combine() {
        let f = HookFlags::empty()
            .with(HookFlag::BeforeBorrow)
            .with(HookFlag::AfterRepay)
            .with(HookFlag::UsesOracle);
        assert!(f.contains(HookFlag::BeforeBorrow));
        assert!(f.contains(HookFlag::AfterRepay));
        assert!(f.contains(HookFlag::UsesOracle));
        assert!(!f.contains(HookFlag::BeforeLiquidate));
        assert!(f.matches_event(LifecycleEventKind::BeforeBorrow));
        assert!(!f.matches_event(LifecycleEventKind::BeforeLiquidate));
    }
}
