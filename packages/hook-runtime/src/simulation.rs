//! Simulation harness — replays a series of lifecycle events through a Composition
//! and reports aggregate metrics (liquidations averted, MEV captured, value at risk).

use serde::{Deserialize, Serialize};

use crate::composition::{Composition, CompositionError, ExecutionTrace, Outcome};
use crate::event::LifecycleEvent;
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
        let mut report = BacktestReport::default();
        for event in events {
            let kind = event.kind.label().to_owned();
            let slot = event.market.slot;
            match self.composition.execute(&event) {
                Ok(trace) => {
                    for (_, side) in &trace.side_effects {
                        match side {
                            SideEffect::OverrideMaxLtvBps(_) => report.ltv_overrides += 1,
                            SideEffect::OverrideRateBps(_) => report.rate_overrides += 1,
                            SideEffect::DelayLiquidationSlots(_) => report.liquidations_delayed += 1,
                            SideEffect::EmitInstruction { .. } => {}
                        }
                    }
                    if matches!(event.kind, crate::event::LifecycleEventKind::AfterLiquidate) {
                        report.liquidations_executed += 1;
                    }
                    let healthy_delta = (event.position.collateral_amount as i64)
                        .saturating_sub(event.position.debt_amount as i64);
                    report.realised_pnl_e8 = report.realised_pnl_e8.saturating_add(healthy_delta);
                    report.steps.push(BacktestStep {
                        slot,
                        kind,
                        trace,
                        rejected: None,
                    });
                }
                Err(CompositionError::Rejected(_, reason)) => {
                    if matches!(event.kind, crate::event::LifecycleEventKind::BeforeBorrow) {
                        report.borrows_rejected += 1;
                    }
                    report.steps.push(BacktestStep {
                        slot,
                        kind,
                        trace: ExecutionTrace::default(),
                        rejected: Some(reason),
                    });
                }
                Err(other) => {
                    report.steps.push(BacktestStep {
                        slot,
                        kind,
                        trace: ExecutionTrace::default(),
                        rejected: Some(other.to_string()),
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
