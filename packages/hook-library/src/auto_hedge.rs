//! AutoHedge — emits a Drift perp-short instruction when collateral price drops below a band.
//! Knot: double helix. Two strands wound together — the deposit and the perp.

use agent_hooks_runtime::{
    Hook, HookContext, HookDecision, HookFlag, HookFlags, HookMeta,
    event::LifecycleEventKind,
    hook::{InstructionKind, SideEffect},
};

pub struct AutoHedge {
    meta: HookMeta,
    /// Price (1e8 scaled) at which a short is opened.
    pub trigger_price_e8: u64,
    /// Hedge ratio in basis points of collateral notional.
    pub hedge_ratio_bps: u16,
    pub market_pubkey: [u8; 32],
}

impl AutoHedge {
    pub fn new(trigger_price_e8: u64, hedge_ratio_bps: u16, market_pubkey: [u8; 32]) -> Self {
        let flags = HookFlags::empty()
            .with(HookFlag::AfterBorrow)
            .with(HookFlag::AfterDeposit)
            .with(HookFlag::UsesOracle)
            .with(HookFlag::MutatePayload);
        Self {
            meta: HookMeta {
                name: "AutoHedge".into(),
                version: "1.0.0".into(),
                author: "agent-hooks-core".into(),
                flags,
                description:
                    "Opens a Drift perp short on the collateral asset when its price drops below the trigger band."
                        .into(),
            },
            trigger_price_e8,
            hedge_ratio_bps,
            market_pubkey,
        }
    }
}

impl Hook for AutoHedge {
    fn meta(&self) -> &HookMeta {
        &self.meta
    }

    fn evaluate(&self, ctx: &HookContext<'_>) -> HookDecision {
        if !matches!(
            ctx.event.kind,
            LifecycleEventKind::AfterBorrow | LifecycleEventKind::AfterDeposit
        ) {
            return HookDecision::Accept;
        }
        let mint = ctx.event.position.collateral_mint;
        let price = match ctx.event.market.price_of(&mint) {
            Some(p) => p,
            None => return HookDecision::Accept,
        };
        if price >= self.trigger_price_e8 {
            return HookDecision::Accept;
        }
        let notional = (ctx.event.position.collateral_amount as u128)
            .saturating_mul(price as u128)
            / 1e8 as u128;
        let hedge_size = notional.saturating_mul(self.hedge_ratio_bps as u128) / 10_000u128;
        let mut payload = Vec::with_capacity(80);
        payload.extend_from_slice(&self.market_pubkey);
        payload.extend_from_slice(&(hedge_size as u64).to_le_bytes());
        payload.extend_from_slice(&price.to_le_bytes());
        payload.extend_from_slice(&self.hedge_ratio_bps.to_le_bytes());
        HookDecision::AcceptWith(SideEffect::EmitInstruction {
            kind: InstructionKind::DriftShort,
            payload,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_hooks_runtime::event::{
        AdapterKind, LifecycleEvent, MarketSnapshot, OraclePoint, PositionSnapshot,
    };

    fn evt(price_e8: u64) -> LifecycleEvent {
        let collateral_mint = [7u8; 32];
        LifecycleEvent {
            kind: LifecycleEventKind::AfterBorrow,
            adapter: AdapterKind::Marginfi,
            position: PositionSnapshot {
                owner: [1; 32],
                collateral_mint,
                debt_mint: [3; 32],
                collateral_amount: 1_000_000_000,
                debt_amount: 500_000_000,
                ltv_bps: 5_000,
                liquidation_threshold_bps: 8_500,
            },
            market: MarketSnapshot {
                slot: 100,
                timestamp: 0,
                oracle_points: vec![OraclePoint {
                    mint: collateral_mint,
                    price_e8,
                    confidence_e8: 1_000,
                    slot: 99,
                }],
                realised_vol_bps: 0,
                utilisation_bps: 0,
            },
            payload: vec![],
        }
    }

    #[test]
    fn accepts_when_above_trigger() {
        let h = AutoHedge::new(8_000_000_000, 5_000, [42; 32]);
        let e = evt(10_000_000_000);
        let ctx = HookContext { event: &e, composition_index: 0, composition_total: 1 };
        assert_eq!(h.evaluate(&ctx), HookDecision::Accept);
    }

    #[test]
    fn emits_drift_short_below_trigger() {
        let h = AutoHedge::new(8_000_000_000, 5_000, [42; 32]);
        let e = evt(6_000_000_000);
        let ctx = HookContext { event: &e, composition_index: 0, composition_total: 1 };
        let decision = h.evaluate(&ctx);
        match decision {
            HookDecision::AcceptWith(SideEffect::EmitInstruction { kind, payload }) => {
                assert_eq!(kind, InstructionKind::DriftShort);
                assert!(payload.len() >= 40);
            }
            other => panic!("unexpected decision {other:?}"),
        }
    }
}
