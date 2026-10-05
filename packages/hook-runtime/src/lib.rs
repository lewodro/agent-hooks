//! Agent Hooks Hook Runtime.
//!
//! Loan lifecycle event interception and hook execution engine for Solana lending protocols.
//! Sits between Marginfi v2 / Kamino Lend / Solend and a Composition of one or more hooks
//! that can read, gate, or modify the lifecycle event before it commits.
//!
//! The execution model is inspired by Uniswap v4 hooks (Hayden Adams et al., Uniswap Labs, 2024)
//! and Token-2022 Transfer Hooks. Unlike Uniswap v4 where hook flags live in the contract address,
//! Agent Hooks hooks register a bitmask in a PDA at install time so any address may host a hook.

pub mod composition;
pub mod event;
pub mod hook;
pub mod permission;
pub mod simulation;

pub use composition::{
    Composition, CompositionBuilder, CompositionError, ExecutionDecision, ExecutionTrace,
};
pub use event::{
    EventValidationError, EventValidationPolicy, ExecutionContext, LifecycleEvent,
    LifecycleEventKind, MarketSnapshot, OraclePoint, PositionSnapshot,
};
pub use hook::{Hook, HookContext, HookDecision, HookFlag, HookFlags, HookMeta};
pub use permission::{PermissionGate, ReputationProvider};
pub use simulation::{BacktestReport, BacktestStep, Simulator};

/// Library-level error surface. Wraps [`CompositionError`] and feeds the host program.
#[derive(thiserror::Error, Debug, PartialEq, Eq)]
pub enum RuntimeError {
    #[error("hook composition rejected the event: {0}")]
    Rejected(String),

    #[error("composition error: {0}")]
    Composition(#[from] CompositionError),

    #[error("required hook flag {0:?} not declared by hook {1}")]
    MissingFlag(HookFlag, String),

    #[error("hook {0} fired on disallowed lifecycle phase")]
    PhaseMismatch(String),

    #[error("oracle data is stale: last update {0} slots ago")]
    StaleOracle(u64),
}

pub type RuntimeResult<T> = Result<T, RuntimeError>;
