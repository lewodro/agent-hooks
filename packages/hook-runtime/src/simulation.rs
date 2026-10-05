//! Simulation harness — replays a series of lifecycle events through a Composition
//! and reports aggregate metrics (liquidations averted, MEV captured, value at risk).

use serde::{Deserialize, Serialize};

use crate::composition::{Composition, ExecutionDecision, ExecutionTrace, Outcome};
use crate::event::{EventValidationPolicy, ExecutionContext, LifecycleEvent};
use crate::hook::SideEffect;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BacktestReport {
    pub steps: Vec<BacktestStep>,
    pub liquidations_executed: u32,
    pub liquidations_delayed: u32,
    pub borrows_rejected: u32,
    pub rate_overrides: u32,
    pub ltv_overrides: u32,
    /// Realised PnL in USD (1e8 scaled) — naive sum of position deltas.
    pub realised_pnl_e8: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BacktestStep {
    pub slot: u64,
    pub kind: String,
    pub trace: ExecutionTrace,
    pub rejected: Option<String>,
}

pub struct Simulator<'a> {
    composition: &'a Composition,
}

impl<'a> Simulator<'a> {
    pub fn new(composition: &'a Composition) -> Self {
        Self { composition }
    }

    pub fn run(&self, events: impl IntoIterator<Item = LifecycleEvent>) -> BacktestReport {
        // Historical replay validates the snapshot and oracle ages relative to the
        // snapshot slot. Live callers must use `run_with_context` with a trusted slot.
        self.run_with_context(events, &EventValidationPolicy::default(), |event| {
            event.market.slot
        })
    }

    /// Replay with a trusted current-slot provider. This is the required path when
    /// event freshness must be measured against the execution environment.
    pub fn run_with_context(
        &self,
        events: impl IntoIterator<Item = LifecycleEvent>,
        policy: &EventValidationPolicy,
        mut current_slot: impl FnMut(&LifecycleEvent) -> u64,
    ) -> BacktestReport {
        let mut report = BacktestReport::default();
        for event in events {
            let kind = event.kind.label().to_owned();
            let slot = event.market.slot;
            let context = ExecutionContext {
                current_slot: current_slot(&event),
            };
            match self.composition.evaluate(&event, context, policy) {
                Ok(trace) => {
                    if matches!(trace.decision, ExecutionDecision::Accepted) {
                        for (_, side) in &trace.side_effects {
                            match side {
                                SideEffect::OverrideMaxLtvBps(_) => report.ltv_overrides += 1,
                                SideEffect::OverrideRateBps(_) => report.rate_overrides += 1,
                                SideEffect::DelayLiquidationSlots(_) => {
                                    report.liquidations_delayed += 1
                                }
                                SideEffect::EmitInstruction { .. } => {}
                            }
                        }
                    }
                    if matches!(trace.decision, ExecutionDecision::Rejected { .. })
                        && matches!(event.kind, crate::event::LifecycleEventKind::BeforeBorrow)
                    {
                        report.borrows_rejected += 1;
                    }
                    if matches!(trace.decision, ExecutionDecision::Accepted)
                        && matches!(event.kind, crate::event::LifecycleEventKind::AfterLiquidate)
                    {
                        report.liquidations_executed += 1;
                    }
                    if matches!(trace.decision, ExecutionDecision::Accepted) {
                        let healthy_delta = (event.position.collateral_amount as i64)
                            .saturating_sub(event.position.debt_amount as i64);
                        report.realised_pnl_e8 =
                            report.realised_pnl_e8.saturating_add(healthy_delta);
                    }
                    let rejected = match &trace.decision {
                        ExecutionDecision::Accepted => None,
                        ExecutionDecision::Rejected { hook_name, reason } => {
                            Some(format!("hook {hook_name} rejected: {reason}"))
                        }
                    };
                    report.steps.push(BacktestStep {
                        slot,
                        kind,
                        trace,
                        rejected,
                    });
                }
                Err(other) => {
                    if matches!(event.kind, crate::event::LifecycleEventKind::BeforeBorrow) {
                        report.borrows_rejected += 1;
                    }
                    let reason = other.to_string();
                    report.steps.push(BacktestStep {
                        slot,
                        kind,
                        trace: ExecutionTrace {
                            decision: ExecutionDecision::Rejected {
                                hook_name: "runtime-validation".into(),
                                reason: reason.clone(),
                            },
                            ..ExecutionTrace::default()
                        },
                        rejected: Some(reason),
                    });
                }
            }
        }
        report
    }
}

impl ExecutionTrace {
    pub fn accepted_count(&self) -> usize {
        self.entries
            .iter()
            .filter(|e| matches!(e.outcome, Outcome::Accepted | Outcome::AcceptedWith(_)))
            .count()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::composition::CompositionBuilder;
    use crate::event::{
        AdapterKind, LifecycleEventKind, MarketSnapshot, OraclePoint, PositionSnapshot,
    };
    use crate::hook::{Hook, HookContext, HookDecision, HookFlag, HookFlags, HookMeta};

    struct AcceptBeforeBorrow(HookMeta);

    impl Hook for AcceptBeforeBorrow {
        fn meta(&self) -> &HookMeta {
            &self.0
        }

        fn evaluate(&self, _ctx: &HookContext<'_>) -> HookDecision {
            HookDecision::Accept
        }
    }

    fn event_with_stale_oracle() -> LifecycleEvent {
        LifecycleEvent {
            kind: LifecycleEventKind::BeforeBorrow,
            adapter: AdapterKind::Marginfi,
            position: PositionSnapshot {
                owner: [1; 32],
                collateral_mint: [2; 32],
                debt_mint: [3; 32],
                collateral_amount: 1_000,
                debt_amount: 500,
                ltv_bps: 5_000,
                liquidation_threshold_bps: 8_000,
            },
            market: MarketSnapshot {
                slot: 200,
                timestamp: 0,
                oracle_points: vec![OraclePoint {
                    mint: [2; 32],
                    price_e8: 10_000,
                    confidence_e8: 100,
                    slot: 100,
                }],
                realised_vol_bps: 200,
                utilisation_bps: 5_000,
            },
            payload: Vec::new(),
        }
    }

    #[test]
    fn live_validation_failure_is_retained_as_a_rejected_backtest_step() {
        let meta = HookMeta {
            name: "accept".into(),
            version: "1".into(),
            author: "test".into(),
            flags: HookFlags::empty().with(HookFlag::BeforeBorrow),
            description: String::new(),
        };
        let composition = CompositionBuilder::new()
            .add(1, Arc::new(AcceptBeforeBorrow(meta)))
            .build()
            .unwrap();
        let report = Simulator::new(&composition).run_with_context(
            [event_with_stale_oracle()],
            &EventValidationPolicy::default(),
            |_| 251,
        );

        assert_eq!(report.steps.len(), 1);
        assert_eq!(report.borrows_rejected, 1);
        assert!(report.steps[0].rejected.is_some());
        assert!(matches!(
            report.steps[0].trace.decision,
            ExecutionDecision::Rejected { ref hook_name, .. }
                if hook_name == "runtime-validation"
        ));
        assert!(report.steps[0].trace.entries.is_empty());
    }
}
