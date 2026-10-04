//! TimeTriggerLiq — only allows liquidations during configured windows.
//! Knot: timer hitch. Lets a position wait out brief oracle divergence.

use agent_hooks_runtime::{
    Hook, HookContext, HookDecision, HookFlag, HookFlags, HookMeta,
    event::LifecycleEventKind,
    hook::SideEffect,
};

#[derive(Clone, Debug)]
pub struct TimeWindow {
    /// Seconds-of-day window start (UTC).
    pub start_sec: u32,
    pub end_sec: u32,
}

pub struct TimeTriggerLiq {
    meta: HookMeta,
    pub allowed: Vec<TimeWindow>,
    /// Maximum slot age for the oracle reading at liquidation time.
    pub max_oracle_age_slots: u64,
    /// If the oracle is stale, delay liquidation by this many slots instead of rejecting.
    pub delay_slots: u64,
}

impl TimeTriggerLiq {
    pub fn new(allowed: Vec<TimeWindow>, max_oracle_age_slots: u64, delay_slots: u64) -> Self {
        let flags = HookFlags::empty()
            .with(HookFlag::BeforeLiquidate)
            .with(HookFlag::UsesOracle)
            .with(HookFlag::MayReject);
        Self {
            meta: HookMeta {
                name: "TimeTriggerLiq".into(),
                version: "1.0.0".into(),
                author: "agent-hooks-core".into(),
                flags,
                description:
                    "Allows liquidations only during operator-defined windows; delays liquidation when oracle is stale."
                        .into(),
            },
            allowed,
            max_oracle_age_slots,
            delay_slots,
        }
    }

    fn within_window(&self, timestamp: i64) -> bool {
        if self.allowed.is_empty() {
            return true;
        }
        let seconds_of_day = ((timestamp.rem_euclid(86_400)) as u32);
        self.allowed
            .iter()
            .any(|w| seconds_of_day >= w.start_sec && seconds_of_day < w.end_sec)
    }
}

impl Hook for TimeTriggerLiq {
    fn meta(&self) -> &HookMeta {
        &self.meta
    }

    fn evaluate(&self, ctx: &HookContext<'_>) -> HookDecision {
        if ctx.event.kind != LifecycleEventKind::BeforeLiquidate {
            return HookDecision::Accept;
        }
        let slot = ctx.event.market.slot;
        let stale = ctx
            .event
            .market
            .oracle_points
            .iter()
            .any(|p| slot.saturating_sub(p.slot) > self.max_oracle_age_slots);
        if stale {
            return HookDecision::AcceptWith(SideEffect::DelayLiquidationSlots(self.delay_slots));
        }
        if !self.within_window(ctx.event.market.timestamp) {
            return HookDecision::Reject(
                "TimeTriggerLiq: liquidation outside operator window".into(),
            );
        }
        HookDecision::Accept
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_hooks_runtime::event::{
        AdapterKind, LifecycleEvent, MarketSnapshot, OraclePoint, PositionSnapshot,
    };

    fn evt(ts: i64, stale: bool) -> LifecycleEvent {
        let slot = 1_000_000u64;
        LifecycleEvent {
            kind: LifecycleEventKind::BeforeLiquidate,
            adapter: AdapterKind::Solend,
            position: PositionSnapshot {
                owner: [9; 32],
                collateral_mint: [2; 32],
                debt_mint: [3; 32],
                collateral_amount: 1_000,
                debt_amount: 900,
                ltv_bps: 9_000,
                liquidation_threshold_bps: 8_500,
            },
            market: MarketSnapshot {
                slot,
                timestamp: ts,
                oracle_points: vec![OraclePoint {
                    mint: [2; 32],
                    price_e8: 100_000_000,
                    confidence_e8: 100_000,
                    slot: if stale { slot - 1_000 } else { slot - 1 },
                }],
                realised_vol_bps: 200,
                utilisation_bps: 5_000,
            },
            payload: vec![],
        }
    }

    #[test]
    fn rejects_outside_window() {
        let h = TimeTriggerLiq::new(
            vec![TimeWindow { start_sec: 36_000, end_sec: 64_800 }], // 10:00 - 18:00 UTC
            500,
            300,
        );
        let e = evt(64_801, false);
        let ctx = HookContext { event: &e, composition_index: 0, composition_total: 1 };
        assert!(matches!(h.evaluate(&ctx), HookDecision::Reject(_)));
    }

    #[test]
    fn delays_when_oracle_stale() {
        let h = TimeTriggerLiq::new(vec![], 500, 300);
        let e = evt(40_000, true);
        let ctx = HookContext { event: &e, composition_index: 0, composition_total: 1 };
        let decision = h.evaluate(&ctx);
        assert!(matches!(
            decision,
            HookDecision::AcceptWith(SideEffect::DelayLiquidationSlots(300))
        ));
    }
}
