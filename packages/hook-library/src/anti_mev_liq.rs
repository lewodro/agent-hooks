//! AntiMEVLiq — sandbox liquidations against MEV searcher frontrunning.
//! Knot: double bowline. Two loops, the legitimate liquidator sits in one, MEV in the other.
//!
//! The hook delays liquidations by a small number of slots, forcing the MEV bot's
//! mempool advantage to evaporate, and (optionally) requires the liquidator to be
//! a registered keeper.

use std::collections::HashSet;

use agent_hooks_runtime::{
    Hook, HookContext, HookDecision, HookFlag, HookFlags, HookMeta,
    event::LifecycleEventKind,
    hook::SideEffect,
};

pub struct AntiMevLiq {
    meta: HookMeta,
    /// Slots to delay every liquidation by — neutralises one-block-ahead MEV.
    pub min_delay_slots: u64,
    /// Optional registered keepers; if empty, any caller may liquidate after the delay.
    pub keepers: HashSet<[u8; 32]>,
}

impl AntiMevLiq {
    pub fn new(min_delay_slots: u64, keepers: HashSet<[u8; 32]>) -> Self {
        let flags = HookFlags::empty()
            .with(HookFlag::BeforeLiquidate)
            .with(HookFlag::MutatePayload)
            .with(HookFlag::MayReject);
        Self {
            meta: HookMeta {
                name: "AntiMEVLiq".into(),
                version: "1.0.0".into(),
                author: "agent-hooks-core".into(),
                flags,
                description:
                    "Delays liquidations and (optionally) restricts to registered keepers to defeat MEV frontrunning."
                        .into(),
            },
            min_delay_slots,
            keepers,
        }
    }

    fn caller_from_payload(payload: &[u8]) -> Option<[u8; 32]> {
        if payload.len() >= 32 {
            let mut out = [0u8; 32];
            out.copy_from_slice(&payload[..32]);
            Some(out)
        } else {
            None
        }
    }
}

impl Hook for AntiMevLiq {
    fn meta(&self) -> &HookMeta {
        &self.meta
    }

    fn evaluate(&self, ctx: &HookContext<'_>) -> HookDecision {
        if ctx.event.kind != LifecycleEventKind::BeforeLiquidate {
            return HookDecision::Accept;
        }
        if !self.keepers.is_empty() {
            let caller = match Self::caller_from_payload(&ctx.event.payload) {
                Some(c) => c,
                None => {
                    return HookDecision::Reject(
                        "AntiMEVLiq: keeper required but caller missing in payload".into(),
                    )
                }
            };
            if !self.keepers.contains(&caller) {
                return HookDecision::Reject(
                    "AntiMEVLiq: caller is not a registered keeper".into(),
                );
            }
        }
        HookDecision::AcceptWith(SideEffect::DelayLiquidationSlots(self.min_delay_slots))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_hooks_runtime::event::{
        AdapterKind, LifecycleEvent, MarketSnapshot, PositionSnapshot,
    };

    fn evt(payload: Vec<u8>) -> LifecycleEvent {
        LifecycleEvent {
            kind: LifecycleEventKind::BeforeLiquidate,
            adapter: AdapterKind::Kamino,
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
                slot: 100,
                timestamp: 0,
                oracle_points: vec![],
                realised_vol_bps: 0,
                utilisation_bps: 0,
            },
            payload,
        }
    }

    #[test]
    fn delays_without_keeper() {
        let h = AntiMevLiq::new(3, HashSet::new());
        let e = evt(vec![]);
        let ctx = HookContext { event: &e, composition_index: 0, composition_total: 1 };
        assert_eq!(
            h.evaluate(&ctx),
            HookDecision::AcceptWith(SideEffect::DelayLiquidationSlots(3))
        );
    }

    #[test]
    fn rejects_unknown_keeper() {
        let me = [1u8; 32];
        let keepers: HashSet<[u8; 32]> = [me].into();
        let h = AntiMevLiq::new(3, keepers);
        let stranger = [2u8; 32];
        let mut payload = vec![0u8; 32];
        payload.copy_from_slice(&stranger);
        let e = evt(payload);
        let ctx = HookContext { event: &e, composition_index: 0, composition_total: 1 };
        assert!(matches!(h.evaluate(&ctx), HookDecision::Reject(_)));
    }
}
