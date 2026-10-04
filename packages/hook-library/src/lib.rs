//! Agent Hooks standard hook library — six knots that every lending pool can tie.
//!
//! Each hook is a small, focused module. Pool operators compose them via the
//! Composition builder in `agent-hooks-runtime`.

pub mod anti_mev_liq;
pub mod auto_hedge;
pub mod dynamic_ltv;
pub mod reputation_rate;
pub mod time_trigger_liq;
pub mod whitelist_borrow;

pub use anti_mev_liq::AntiMevLiq;
pub use auto_hedge::AutoHedge;
pub use dynamic_ltv::DynamicLtv;
pub use reputation_rate::ReputationRate;
pub use time_trigger_liq::TimeTriggerLiq;
pub use whitelist_borrow::WhitelistBorrow;

/// All six standard hook identifiers, in the order they appear in the workshop diagram.
pub const STANDARD_HOOKS: &[&str] = &[
    "DynamicLTV",
    "TimeTriggerLiq",
    "WhitelistBorrow",
    "AntiMEVLiq",
    "AutoHedge",
    "ReputationRate",
];
