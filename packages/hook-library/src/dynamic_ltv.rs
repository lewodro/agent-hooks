//! DynamicLTV — adjusts max LTV in response to realised volatility.
//!
//! Knot: slip knot. When volatility tightens, the knot tightens too (lower LTV).

use agent_hooks_runtime::{
    event::LifecycleEventKind, hook::SideEffect, Hook, HookContext, HookDecision, HookFlag,
    HookFlags, HookMeta,
};

pub struct DynamicLtv {
    meta: HookMeta,
    pub base_ltv_bps: u16,
    /// Drop max LTV by this many bps per 100 bps of realised vol above the floor.
    pub sensitivity: u16,
    /// Vol floor in bps below which no adjustment applies.
    pub vol_floor_bps: u32,
    pub min_ltv_bps: u16,
}

impl DynamicLtv {
    pub fn new(base_ltv_bps: u16, sensitivity: u16, vol_floor_bps: u32, min_ltv_bps: u16) -> Self {
        let flags = HookFlags::empty()
            .with(HookFlag::BeforeBorrow)
            .with(HookFlag::AfterDeposit)
            .with(HookFlag::UsesOracle)
            .with(HookFlag::MutatePayload)
            .with(HookFlag::MayReject);
        Self {
            meta: HookMeta {
                name: "DynamicLTV".into(),
                version: "1.0.0".into(),
                author: "agent-hooks-core".into(),
                flags,
                description:
                    "Adjusts the maximum LTV based on realised volatility. Tighter knot when markets move."
                        .into(),
            },
            base_ltv_bps,
            sensitivity,
            vol_floor_bps,
            min_ltv_bps,
        }
    }

    fn target_ltv(&self, realised_vol_bps: u32) -> u16 {
        let excess = realised_vol_bps.saturating_sub(self.vol_floor_bps);
        let drop = (excess / 100) as u32 * self.sensitivity as u32;
        let new_ltv = (self.base_ltv_bps as u32).saturating_sub(drop);
        new_ltv.max(self.min_ltv_bps as u32) as u16
    }
}

impl Hook for DynamicLtv {
    fn meta(&self) -> &HookMeta {
        &self.meta
    }

    fn evaluate(&self, ctx: &HookContext<'_>) -> HookDecision {
        let target = self.target_ltv(ctx.event.market.realised_vol_bps);
        if ctx.event.kind == LifecycleEventKind::BeforeBorrow && ctx.event.position.ltv_bps > target
        {
            return HookDecision::Reject(format!(
                "DynamicLTV: position LTV {} bps exceeds dynamic cap {} bps (vol {} bps)",
                ctx.event.position.ltv_bps, target, ctx.event.market.realised_vol_bps
            ));
        }
        HookDecision::AcceptWith(SideEffect::OverrideMaxLtvBps(target))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_hooks_runtime::event::{
        AdapterKind, LifecycleEvent, MarketSnapshot, PositionSnapshot,
    };

    fn evt(vol_bps: u32, ltv_bps: u16) -> LifecycleEvent {
        LifecycleEvent {
            kind: LifecycleEventKind::BeforeBorrow,
            adapter: AdapterKind::Marginfi,
            position: PositionSnapshot {
                owner: [1; 32],
                collateral_mint: [2; 32],
                debt_mint: [3; 32],
                collateral_amount: 1_000,
                debt_amount: 500,
                ltv_bps,
                liquidation_threshold_bps: 8000,
            },
            market: MarketSnapshot {
                slot: 100,
                timestamp: 0,
                oracle_points: vec![],
                realised_vol_bps: vol_bps,
                utilisation_bps: 5_000,
            },
            payload: vec![],
        }
    }

    #[test]
    fn calm_market_uses_base() {
        let h = DynamicLtv::new(7_500, 50, 1_000, 2_500);
        let ctx_event = evt(800, 5_000);
        let ctx = HookContext {
            event: &ctx_event,
            composition_index: 0,
            composition_total: 1,
        };
        let decision = h.evaluate(&ctx);
        match decision {
            HookDecision::AcceptWith(SideEffect::OverrideMaxLtvBps(v)) => {
                assert_eq!(v, 7_500);
            }
            other => panic!("unexpected decision {other:?}"),
        }
    }

    #[test]
    fn volatile_market_tightens_ltv() {
        let h = DynamicLtv::new(7_500, 50, 1_000, 2_500);
        let ctx_event = evt(5_000, 5_000);
        let ctx = HookContext {
            event: &ctx_event,
            composition_index: 0,
            composition_total: 1,
        };
        let decision = h.evaluate(&ctx);
        match decision {
            HookDecision::AcceptWith(SideEffect::OverrideMaxLtvBps(v)) => {
                // (5000 - 1000) / 100 * 50 = 2000; 7500 - 2000 = 5500
                assert_eq!(v, 5_500);
            }
            other => panic!("unexpected decision {other:?}"),
        }
    }

    #[test]
    fn rejects_when_position_exceeds_cap() {
        let h = DynamicLtv::new(7_500, 50, 1_000, 2_500);
        let ctx_event = evt(5_000, 7_000);
        let ctx = HookContext {
            event: &ctx_event,
            composition_index: 0,
            composition_total: 1,
        };
        let decision = h.evaluate(&ctx);
        assert!(matches!(decision, HookDecision::Reject(_)));
    }
}
