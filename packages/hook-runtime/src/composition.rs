//! Composition: an ordered list of hooks plus priority resolution.
//!
//! Compositions are the "knot tying" primitive — multiple hooks bound together
//! so that a single lifecycle event flows through all of them in deterministic order.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::event::LifecycleEvent;
use crate::hook::{Hook, HookContext, HookDecision, HookMeta, SideEffect};

#[derive(thiserror::Error, Debug, PartialEq, Eq)]
pub enum CompositionError {
    #[error("composition is empty")]
    Empty,

    #[error("hook \"{0}\" rejected the event: {1}")]
    Rejected(String, String),

    #[error("composition exceeds runtime budget of {0} hooks")]
    BudgetExceeded(usize),
}

const MAX_HOOKS_PER_COMPOSITION: usize = 8;

/// Builder for a [`Composition`]. Hooks are stored in priority order (lowest priority first).
pub struct CompositionBuilder {
    hooks: Vec<(u16, Arc<dyn Hook>)>,
}

impl CompositionBuilder {
    pub fn new() -> Self {
        Self { hooks: Vec::new() }
    }

    /// Add a hook with the given priority. Lower priority runs first.
    pub fn add(mut self, priority: u16, hook: Arc<dyn Hook>) -> Self {
        self.hooks.push((priority, hook));
        self
    }

    pub fn build(mut self) -> Result<Composition, CompositionError> {
        if self.hooks.is_empty() {
            return Err(CompositionError::Empty);
        }
        if self.hooks.len() > MAX_HOOKS_PER_COMPOSITION {
            return Err(CompositionError::BudgetExceeded(MAX_HOOKS_PER_COMPOSITION));
        }
        self.hooks.sort_by_key(|(p, _)| *p);
        Ok(Composition {
            hooks: self.hooks.into_iter().map(|(_, h)| h).collect(),
        })
    }
}

impl Default for CompositionBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// A built composition. Immutable once constructed.
pub struct Composition {
    hooks: Vec<Arc<dyn Hook>>,
}

impl Composition {
    pub fn meta(&self) -> Vec<&HookMeta> {
        self.hooks.iter().map(|h| h.meta()).collect()
    }

    pub fn len(&self) -> usize {
        self.hooks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.hooks.is_empty()
    }

    /// Run the event through every hook in priority order. Each hook sees the event
    /// + its position in the composition; side-effects accumulate.
    pub fn execute(&self, event: &LifecycleEvent) -> Result<ExecutionTrace, CompositionError> {
        let mut trace = ExecutionTrace::default();
        let total = self.hooks.len();
        for (idx, hook) in self.hooks.iter().enumerate() {
            let meta = hook.meta();
            if !meta.flags.matches_event(event.kind) {
                trace.entries.push(TraceEntry {
                    hook_name: meta.name.clone(),
                    outcome: Outcome::Skipped,
                });
                continue;
            }
            let ctx = HookContext {
                event,
                composition_index: idx,
                composition_total: total,
            };
            match hook.evaluate(&ctx) {
                HookDecision::Accept => trace.entries.push(TraceEntry {
                    hook_name: meta.name.clone(),
                    outcome: Outcome::Accepted,
                }),
                HookDecision::AcceptWith(side) => {
                    trace.entries.push(TraceEntry {
                        hook_name: meta.name.clone(),
                        outcome: Outcome::AcceptedWith(side.clone()),
                    });
                    trace.side_effects.push((meta.name.clone(), side));
                }
                HookDecision::Reject(reason) => {
                    trace.entries.push(TraceEntry {
                        hook_name: meta.name.clone(),
                        outcome: Outcome::Rejected(reason.clone()),
                    });
                    return Err(CompositionError::Rejected(meta.name.clone(), reason));
                }
            }
        }
        Ok(trace)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ExecutionTrace {
    pub entries: Vec<TraceEntry>,
    pub side_effects: Vec<(String, SideEffect)>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TraceEntry {
    pub hook_name: String,
    pub outcome: Outcome,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Outcome {
    Skipped,
    Accepted,
    AcceptedWith(SideEffect),
    Rejected(String),
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::event::{AdapterKind, LifecycleEvent, LifecycleEventKind, MarketSnapshot, PositionSnapshot};
    use crate::hook::{HookFlag, HookFlags, HookMeta};

    struct AlwaysAccept(HookMeta);

    impl Hook for AlwaysAccept {
        fn meta(&self) -> &HookMeta {
            &self.0
        }
        fn evaluate(&self, _ctx: &HookContext<'_>) -> HookDecision {
            HookDecision::Accept
        }
    }

    fn meta(name: &str, flag: HookFlag) -> HookMeta {
        HookMeta {
            name: name.into(),
            version: "0.1.0".into(),
            author: "test".into(),
            flags: HookFlags::empty().with(flag),
            description: "".into(),
        }
    }

    fn dummy_event(kind: LifecycleEventKind) -> LifecycleEvent {
        LifecycleEvent {
            kind,
            adapter: AdapterKind::Marginfi,
            position: PositionSnapshot {
                owner: [1; 32],
                collateral_mint: [2; 32],
                debt_mint: [3; 32],
                collateral_amount: 1000,
                debt_amount: 500,
                ltv_bps: 5000,
                liquidation_threshold_bps: 8000,
            },
            market: MarketSnapshot {
                slot: 0,
                timestamp: 0,
                oracle_points: vec![],
                realised_vol_bps: 200,
                utilisation_bps: 5000,
            },
            payload: vec![],
        }
    }

    #[test]
    fn builder_rejects_empty() {
        assert_eq!(CompositionBuilder::new().build().err(), Some(CompositionError::Empty));
    }

    #[test]
    fn priority_orders_hooks() {
        let comp = CompositionBuilder::new()
            .add(10, Arc::new(AlwaysAccept(meta("late", HookFlag::BeforeBorrow))))
            .add(1, Arc::new(AlwaysAccept(meta("early", HookFlag::BeforeBorrow))))
            .build()
            .unwrap();
        let trace = comp.execute(&dummy_event(LifecycleEventKind::BeforeBorrow)).unwrap();
        assert_eq!(trace.entries[0].hook_name, "early");
        assert_eq!(trace.entries[1].hook_name, "late");
    }

    #[test]
    fn skips_event_when_flag_missing() {
        let comp = CompositionBuilder::new()
            .add(1, Arc::new(AlwaysAccept(meta("only-deposit", HookFlag::BeforeDeposit))))
            .build()
            .unwrap();
        let trace = comp.execute(&dummy_event(LifecycleEventKind::BeforeBorrow)).unwrap();
        assert!(matches!(trace.entries[0].outcome, Outcome::Skipped));
    }
}
