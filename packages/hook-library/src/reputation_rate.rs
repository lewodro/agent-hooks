//! ReputationRate — quotes a discounted borrow rate to repeat-customer borrowers.
//! Knot: rolling hitch (releases as reputation grows).

use std::sync::Arc;

use agent_hooks_runtime::{
    event::LifecycleEventKind, hook::SideEffect, permission::ReputationProvider, Hook, HookContext,
    HookDecision, HookFlag, HookFlags, HookMeta,
};

pub struct ReputationRate {
    meta: HookMeta,
    pub provider: Arc<dyn ReputationProvider>,
    pub base_rate_bps: u16,
    /// Max discount in bps applied to base when reputation == 10_000.
    pub max_discount_bps: u16,
}

impl ReputationRate {
    pub fn new(
        provider: Arc<dyn ReputationProvider>,
        base_rate_bps: u16,
        max_discount_bps: u16,
    ) -> Self {
        let flags = HookFlags::empty()
            .with(HookFlag::BeforeBorrow)
            .with(HookFlag::MutatesRate);
        Self {
            meta: HookMeta {
                name: "ReputationRate".into(),
                version: "1.0.0".into(),
                author: "agent-hooks-core".into(),
                flags,
                description:
                    "Discounts the borrow rate proportionally to the borrower's on-chain repayment reputation."
                        .into(),
            },
            provider,
            base_rate_bps,
            max_discount_bps,
        }
    }

    pub fn rate_for(&self, score_bps: u16) -> u16 {
        let discount = (self.max_discount_bps as u32 * score_bps as u32) / 10_000;
        let rate = (self.base_rate_bps as u32).saturating_sub(discount);
        rate.min(u16::MAX as u32) as u16
    }
}

impl Hook for ReputationRate {
    fn meta(&self) -> &HookMeta {
        &self.meta
    }

    fn evaluate(&self, ctx: &HookContext<'_>) -> HookDecision {
        if ctx.event.kind != LifecycleEventKind::BeforeBorrow {
            return HookDecision::Accept;
        }
        let score = self.provider.score(&ctx.event.position.owner);
        let new_rate = self.rate_for(score);
        HookDecision::AcceptWith(SideEffect::OverrideRateBps(new_rate))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_hooks_runtime::event::{
        AdapterKind, LifecycleEvent, MarketSnapshot, PositionSnapshot,
    };
    use agent_hooks_runtime::permission::MemoryReputation;

    fn evt(owner: [u8; 32]) -> LifecycleEvent {
        LifecycleEvent {
            kind: LifecycleEventKind::BeforeBorrow,
            adapter: AdapterKind::Marginfi,
            position: PositionSnapshot {
                owner,
                collateral_mint: [2; 32],
                debt_mint: [3; 32],
                collateral_amount: 1_000,
                debt_amount: 0,
                ltv_bps: 0,
                liquidation_threshold_bps: 8_000,
            },
            market: MarketSnapshot {
                slot: 0,
                timestamp: 0,
                oracle_points: vec![],
                realised_vol_bps: 0,
                utilisation_bps: 0,
            },
            payload: vec![],
        }
    }

    #[test]
    fn unknown_borrower_pays_base_rate() {
        let rep = Arc::new(MemoryReputation::new());
        let h = ReputationRate::new(rep, 1_200, 600);
        let e = evt([8; 32]);
        let ctx = HookContext {
            event: &e,
            composition_index: 0,
            composition_total: 1,
        };
        assert_eq!(
            h.evaluate(&ctx),
            HookDecision::AcceptWith(SideEffect::OverrideRateBps(1_200))
        );
    }

    #[test]
    fn high_reputation_gets_max_discount() {
        let rep = Arc::new(MemoryReputation::new());
        rep.record([5; 32], 10_000, 100);
        let h = ReputationRate::new(rep, 1_200, 600);
        let e = evt([5; 32]);
        let ctx = HookContext {
            event: &e,
            composition_index: 0,
            composition_total: 1,
        };
        assert_eq!(
            h.evaluate(&ctx),
            HookDecision::AcceptWith(SideEffect::OverrideRateBps(600))
        );
    }
}
