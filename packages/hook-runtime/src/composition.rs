//! Composition: an ordered list of hooks plus priority resolution.
//!
//! Compositions are the "knot tying" primitive — multiple hooks bound together
//! so that a single lifecycle event flows through all of them in deterministic order.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::event::{EventValidationError, EventValidationPolicy, ExecutionContext, LifecycleEvent};
use crate::hook::{Hook, HookContext, HookDecision, HookFlag, HookFlags, HookMeta, SideEffect};

#[derive(thiserror::Error, Debug, PartialEq, Eq)]
pub enum CompositionError {
    #[error("composition is empty")]
    Empty,

    #[error("hook \"{0}\" rejected the event: {1}")]
    Rejected(String, String),

    #[error("composition exceeds runtime budget of {0} hooks")]
    BudgetExceeded(usize),

    #[error("invalid lifecycle event: {0}")]
    InvalidEvent(#[from] EventValidationError),

    #[error("hook \"{0}\" requires oracle data but the event has none")]
    MissingOracleData(String),
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

    /// Evaluate the event and retain every decision, including the rejecting hook.
    /// Effects from a rejected composition are omitted from `side_effects`; the
    /// per-entry trace still records what hooks proposed before rejection.
    pub fn evaluate(
        &self,
        event: &LifecycleEvent,
        context: ExecutionContext,
        policy: &EventValidationPolicy,
    ) -> Result<ExecutionTrace, CompositionError> {
        event.validate(context, policy)?;
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
            if meta.flags.contains(HookFlag::UsesOracle) && event.market.oracle_points.is_empty() {
                return Err(CompositionError::MissingOracleData(meta.name.clone()));
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
                    if let Err(reason) = validate_side_effect(&side, meta.flags, policy) {
                        trace.entries.push(TraceEntry {
                            hook_name: meta.name.clone(),
                            outcome: Outcome::Rejected(reason.clone()),
                        });
                        trace.side_effects.clear();
                        trace.decision = ExecutionDecision::Rejected {
                            hook_name: meta.name.clone(),
                            reason,
                        };
                        return Ok(trace);
                    }
                    trace.entries.push(TraceEntry {
                        hook_name: meta.name.clone(),
                        outcome: Outcome::AcceptedWith(side.clone()),
                    });
                    trace.side_effects.push((meta.name.clone(), side));
                }
                HookDecision::Reject(reason) => {
                    if !meta.flags.contains(HookFlag::MayReject) {
                        let reason = "hook rejected without declaring MayReject".to_owned();
                        trace.entries.push(TraceEntry {
                            hook_name: meta.name.clone(),
                            outcome: Outcome::Rejected(reason.clone()),
                        });
                        trace.side_effects.clear();
                        trace.decision = ExecutionDecision::Rejected {
                            hook_name: meta.name.clone(),
                            reason,
                        };
                        return Ok(trace);
                    }
                    trace.entries.push(TraceEntry {
                        hook_name: meta.name.clone(),
                        outcome: Outcome::Rejected(reason.clone()),
                    });
                    trace.side_effects.clear();
                    trace.decision = ExecutionDecision::Rejected {
                        hook_name: meta.name.clone(),
                        reason,
                    };
                    return Ok(trace);
                }
            }
        }
        Ok(trace)
    }

    /// Compatibility convenience for callers that still want rejection as an error.
    /// Use `evaluate` when the decision trace must be retained for audit or learning.
    pub fn execute(
        &self,
        event: &LifecycleEvent,
        context: ExecutionContext,
        policy: &EventValidationPolicy,
    ) -> Result<ExecutionTrace, CompositionError> {
        let trace = self.evaluate(event, context, policy)?;
        match &trace.decision {
            ExecutionDecision::Accepted => Ok(trace),
            ExecutionDecision::Rejected { hook_name, reason } => Err(CompositionError::Rejected(
                hook_name.clone(),
                reason.clone(),
            )),
        }
    }
}

fn validate_side_effect(
    side_effect: &SideEffect,
    flags: HookFlags,
    policy: &EventValidationPolicy,
) -> Result<(), String> {
    match side_effect {
        SideEffect::OverrideMaxLtvBps(value) => {
            require_capability(flags, HookFlag::MutatePayload)?;
            if *value > policy.max_ltv_bps || *value > 10_000 {
                return Err(format!(
                    "maximum LTV {value} bps exceeds configured limit {} bps",
                    policy.max_ltv_bps
                ));
            }
        }
        SideEffect::OverrideRateBps(value) => {
            require_capability(flags, HookFlag::MutatesRate)?;
            if *value > 10_000 {
                return Err(format!("rate {value} bps exceeds 10000 bps"));
            }
        }
        SideEffect::DelayLiquidationSlots(value) => {
            require_capability(flags, HookFlag::MutatePayload)?;
            if *value > policy.max_liquidation_delay_slots {
                return Err(format!(
                    "liquidation delay {value} slots exceeds configured limit {} slots",
                    policy.max_liquidation_delay_slots
                ));
            }
        }
        SideEffect::EmitInstruction { payload, .. } => {
            require_capability(flags, HookFlag::MutatePayload)?;
            if payload.len() > policy.max_instruction_payload_bytes {
                return Err(format!(
                    "instruction payload has {} bytes (maximum {})",
                    payload.len(),
                    policy.max_instruction_payload_bytes
                ));
            }
        }
    }
    Ok(())
}

fn require_capability(flags: HookFlags, capability: HookFlag) -> Result<(), String> {
    if flags.contains(capability) {
        Ok(())
    } else {
        Err(format!("hook used {capability:?} without declaring it"))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExecutionDecision {
    Accepted,
    Rejected { hook_name: String, reason: String },
}

impl Default for ExecutionDecision {
    fn default() -> Self {
        Self::Accepted
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ExecutionTrace {
    pub entries: Vec<TraceEntry>,
    /// Side effects a downstream host may apply; always empty on rejection.
    pub side_effects: Vec<(String, SideEffect)>,
    pub decision: ExecutionDecision,
}

impl ExecutionTrace {
    pub fn is_accepted(&self) -> bool {
        matches!(self.decision, ExecutionDecision::Accepted)
    }

    pub fn rejection_reason(&self) -> Option<&str> {
        match &self.decision {
            ExecutionDecision::Accepted => None,
            ExecutionDecision::Rejected { reason, .. } => Some(reason),
        }
    }
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
    use crate::event::{
        AdapterKind, EventValidationPolicy, ExecutionContext, LifecycleEvent, LifecycleEventKind,
        MarketSnapshot, PositionSnapshot,
    };
    use crate::hook::{HookFlag, HookFlags, HookMeta, SideEffect};

    struct AlwaysAccept(HookMeta);

    impl Hook for AlwaysAccept {
        fn meta(&self) -> &HookMeta {
            &self.0
        }
        fn evaluate(&self, _ctx: &HookContext<'_>) -> HookDecision {
            HookDecision::Accept
        }
    }

    struct AlwaysReject(HookMeta);

    impl Hook for AlwaysReject {
        fn meta(&self) -> &HookMeta {
            &self.0
        }
        fn evaluate(&self, _ctx: &HookContext<'_>) -> HookDecision {
            HookDecision::Reject("policy denied".into())
        }
    }

    struct AcceptWithEffect(HookMeta, SideEffect);

    impl Hook for AcceptWithEffect {
        fn meta(&self) -> &HookMeta {
            &self.0
        }
        fn evaluate(&self, _ctx: &HookContext<'_>) -> HookDecision {
            HookDecision::AcceptWith(self.1.clone())
        }
    }

    fn meta(name: &str, flag: HookFlag) -> HookMeta {
        meta_with_flags(name, HookFlags::empty().with(flag))
    }

    fn meta_with_flags(name: &str, flags: HookFlags) -> HookMeta {
        HookMeta {
            name: name.into(),
            version: "0.1.0".into(),
            author: "test".into(),
            flags,
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
        assert_eq!(
            CompositionBuilder::new().build().err(),
            Some(CompositionError::Empty)
        );
    }

    #[test]
    fn priority_orders_hooks() {
        let comp = CompositionBuilder::new()
            .add(
                10,
                Arc::new(AlwaysAccept(meta("late", HookFlag::BeforeBorrow))),
            )
            .add(
                1,
                Arc::new(AlwaysAccept(meta("early", HookFlag::BeforeBorrow))),
            )
            .build()
            .unwrap();
        let trace = comp
            .execute(
                &dummy_event(LifecycleEventKind::BeforeBorrow),
                ExecutionContext { current_slot: 0 },
                &EventValidationPolicy::default(),
            )
            .unwrap();
        assert_eq!(trace.entries[0].hook_name, "early");
        assert_eq!(trace.entries[1].hook_name, "late");
    }

    #[test]
    fn skips_event_when_flag_missing() {
        let comp = CompositionBuilder::new()
            .add(
                1,
                Arc::new(AlwaysAccept(meta("only-deposit", HookFlag::BeforeDeposit))),
            )
            .build()
            .unwrap();
        let trace = comp
            .execute(
                &dummy_event(LifecycleEventKind::BeforeBorrow),
                ExecutionContext { current_slot: 0 },
                &EventValidationPolicy::default(),
            )
            .unwrap();
        assert!(matches!(trace.entries[0].outcome, Outcome::Skipped));
    }

    #[test]
    fn rejection_keeps_audit_trace_but_discards_effects() {
        let comp = CompositionBuilder::new()
            .add(
                1,
                Arc::new(AcceptWithEffect(
                    meta_with_flags(
                        "adjust-ltv",
                        HookFlags::empty()
                            .with(HookFlag::BeforeBorrow)
                            .with(HookFlag::MutatePayload),
                    ),
                    SideEffect::OverrideMaxLtvBps(6_000),
                )),
            )
            .add(
                2,
                Arc::new(AlwaysReject(meta_with_flags(
                    "deny-borrow",
                    HookFlags::empty()
                        .with(HookFlag::BeforeBorrow)
                        .with(HookFlag::MayReject),
                ))),
            )
            .build()
            .unwrap();
        let trace = comp
            .evaluate(
                &dummy_event(LifecycleEventKind::BeforeBorrow),
                ExecutionContext { current_slot: 0 },
                &EventValidationPolicy::default(),
            )
            .unwrap();
        assert_eq!(trace.entries.len(), 2);
        assert!(matches!(trace.entries[0].outcome, Outcome::AcceptedWith(_)));
        assert!(matches!(trace.entries[1].outcome, Outcome::Rejected(_)));
        assert!(matches!(trace.decision, ExecutionDecision::Rejected { .. }));
        assert!(trace.side_effects.is_empty());
    }

    #[test]
    fn side_effects_require_capabilities_and_stay_within_policy() {
        let unprivileged = CompositionBuilder::new()
            .add(
                1,
                Arc::new(AcceptWithEffect(
                    meta("unprivileged", HookFlag::BeforeBorrow),
                    SideEffect::OverrideMaxLtvBps(6_000),
                )),
            )
            .build()
            .unwrap();
        let trace = unprivileged
            .evaluate(
                &dummy_event(LifecycleEventKind::BeforeBorrow),
                ExecutionContext { current_slot: 0 },
                &EventValidationPolicy::default(),
            )
            .unwrap();
        assert!(matches!(trace.decision, ExecutionDecision::Rejected { .. }));
        assert!(trace.rejection_reason().unwrap().contains("MutatePayload"));
        assert!(trace.side_effects.is_empty());

        let out_of_bounds = CompositionBuilder::new()
            .add(
                1,
                Arc::new(AcceptWithEffect(
                    meta_with_flags(
                        "invalid-ltv",
                        HookFlags::empty()
                            .with(HookFlag::BeforeBorrow)
                            .with(HookFlag::MutatePayload),
                    ),
                    SideEffect::OverrideMaxLtvBps(10_001),
                )),
            )
            .build()
            .unwrap();
        let trace = out_of_bounds
            .evaluate(
                &dummy_event(LifecycleEventKind::BeforeBorrow),
                ExecutionContext { current_slot: 0 },
                &EventValidationPolicy::default(),
            )
            .unwrap();
        assert!(trace
            .rejection_reason()
            .unwrap()
            .contains("exceeds configured limit"));
        assert!(trace.side_effects.is_empty());
    }

    #[test]
    fn rejection_requires_may_reject_capability() {
        let comp = CompositionBuilder::new()
            .add(
                1,
                Arc::new(AlwaysReject(meta(
                    "undeclared-reject",
                    HookFlag::BeforeBorrow,
                ))),
            )
            .build()
            .unwrap();
        let trace = comp
            .evaluate(
                &dummy_event(LifecycleEventKind::BeforeBorrow),
                ExecutionContext { current_slot: 0 },
                &EventValidationPolicy::default(),
            )
            .unwrap();
        assert_eq!(
            trace.rejection_reason(),
            Some("hook rejected without declaring MayReject")
        );
    }

    #[test]
    fn oracle_capability_requires_observations() {
        let oracle_hook = HookMeta {
            name: "needs-oracle".into(),
            version: "1".into(),
            author: "test".into(),
            flags: HookFlags::empty()
                .with(HookFlag::BeforeBorrow)
                .with(HookFlag::UsesOracle),
            description: String::new(),
        };
        let comp = CompositionBuilder::new()
            .add(1, Arc::new(AlwaysAccept(oracle_hook)))
            .build()
            .unwrap();
        assert!(matches!(
            comp.evaluate(
                &dummy_event(LifecycleEventKind::BeforeBorrow),
                ExecutionContext { current_slot: 0 },
                &EventValidationPolicy::default(),
            ),
            Err(CompositionError::MissingOracleData(_))
        ));
    }
}
