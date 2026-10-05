//! Lifecycle events that flow through the hook runtime.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventValidationPolicy {
    pub max_event_age_slots: u64,
    pub max_oracle_age_slots: u64,
    pub max_payload_bytes: usize,
    pub max_oracle_points: usize,
    pub max_oracle_confidence_bps: u16,
    pub max_ltv_bps: u16,
}

impl Default for EventValidationPolicy {
    fn default() -> Self {
        Self {
            max_event_age_slots: 150,
            max_oracle_age_slots: 150,
            max_payload_bytes: 256,
            max_oracle_points: 16,
            max_oracle_confidence_bps: 1_000,
            max_ltv_bps: 10_000,
        }
    }
}

/// Trusted execution-time data supplied by the host, not copied from the event.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct ExecutionContext {
    pub current_slot: u64,
}

#[derive(thiserror::Error, Clone, Debug, PartialEq, Eq)]
pub enum EventValidationError {
    #[error("event validation policy contains a basis-point limit above 10000")]
    InvalidValidationPolicy,
    #[error("market snapshot is from a future slot")]
    FutureMarketSnapshot,
    #[error("market snapshot is {age} slots old (maximum {maximum})")]
    StaleMarketSnapshot { age: u64, maximum: u64 },
    #[error("event payload has {size} bytes (maximum {maximum})")]
    PayloadTooLarge { size: usize, maximum: usize },
    #[error("position LTV exceeds the configured maximum")]
    LtvOutOfRange,
    #[error("liquidation threshold or utilisation exceeds 10000 bps")]
    BasisPointsOutOfRange,
    #[error("event contains too many oracle observations")]
    TooManyOraclePoints,
    #[error("oracle observation timestamp is newer than its market snapshot")]
    FutureOracleObservation,
    #[error("oracle observation for mint {0:?} is duplicated")]
    DuplicateOracleMint([u8; 32]),
    #[error("oracle observation for mint {mint:?} has invalid price/confidence")]
    InvalidOracleObservation { mint: [u8; 32] },
    #[error("oracle observation for mint {mint:?} is {age} slots old (maximum {maximum})")]
    StaleOracleObservation {
        mint: [u8; 32],
        age: u64,
        maximum: u64,
    },
}

/// Discrete points in the loan lifecycle at which a hook may run.
///
/// Modelled after Aave v3's pre/post action hooks and Uniswap v4's beforeSwap/afterSwap
/// pair, mapped onto the four core lending actions: deposit, borrow, repay, liquidate.
#[derive(
    Copy,
    Clone,
    Debug,
    PartialEq,
    Eq,
    Hash,
    BorshSerialize,
    BorshDeserialize,
    Serialize,
    Deserialize,
)]
pub enum LifecycleEventKind {
    BeforeDeposit,
    AfterDeposit,
    BeforeBorrow,
    AfterBorrow,
    BeforeRepay,
    AfterRepay,
    BeforeLiquidate,
    AfterLiquidate,
}

impl LifecycleEventKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::BeforeDeposit => "beforeDeposit",
            Self::AfterDeposit => "afterDeposit",
            Self::BeforeBorrow => "beforeBorrow",
            Self::AfterBorrow => "afterBorrow",
            Self::BeforeRepay => "beforeRepay",
            Self::AfterRepay => "afterRepay",
            Self::BeforeLiquidate => "beforeLiquidate",
            Self::AfterLiquidate => "afterLiquidate",
        }
    }

    pub fn is_before(self) -> bool {
        matches!(
            self,
            Self::BeforeDeposit | Self::BeforeBorrow | Self::BeforeRepay | Self::BeforeLiquidate
        )
    }
}

/// Snapshot of a position at the moment the event fires.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize, PartialEq)]
pub struct PositionSnapshot {
    pub owner: [u8; 32],
    pub collateral_mint: [u8; 32],
    pub debt_mint: [u8; 32],
    pub collateral_amount: u64,
    pub debt_amount: u64,
    /// Current LTV in basis points (10000 = 100%).
    pub ltv_bps: u16,
    /// Liquidation threshold in basis points.
    pub liquidation_threshold_bps: u16,
}

impl PositionSnapshot {
    pub fn health_factor_bps(&self) -> u32 {
        if self.ltv_bps == 0 {
            return u32::MAX;
        }
        (self.liquidation_threshold_bps as u32) * 10_000 / (self.ltv_bps as u32)
    }
}

/// One oracle observation feeding the runtime.
#[derive(
    Copy, Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize, PartialEq,
)]
pub struct OraclePoint {
    pub mint: [u8; 32],
    /// Price in USD scaled by 1e8.
    pub price_e8: u64,
    /// Confidence interval in the same scale.
    pub confidence_e8: u64,
    /// Slot the price was published.
    pub slot: u64,
}

/// Aggregated market signal at event time.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize, PartialEq)]
pub struct MarketSnapshot {
    pub slot: u64,
    pub timestamp: i64,
    pub oracle_points: Vec<OraclePoint>,
    /// Realised volatility in basis points over the trailing window.
    pub realised_vol_bps: u32,
    /// Pool utilisation in basis points.
    pub utilisation_bps: u16,
}

impl MarketSnapshot {
    pub fn price_of(&self, mint: &[u8; 32]) -> Option<u64> {
        self.oracle_points
            .iter()
            .find(|p| &p.mint == mint)
            .map(|p| p.price_e8)
    }

    pub fn slots_since(&self, mint: &[u8; 32]) -> Option<u64> {
        self.oracle_points
            .iter()
            .find(|p| &p.mint == mint)
            .map(|p| self.slot.saturating_sub(p.slot))
    }
}

/// The actual event flowing through the runtime.
#[derive(Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize, PartialEq)]
pub struct LifecycleEvent {
    pub kind: LifecycleEventKind,
    pub adapter: AdapterKind,
    pub position: PositionSnapshot,
    pub market: MarketSnapshot,
    /// Caller-supplied arbitrary bytes (action amount, liquidator pubkey, etc.).
    pub payload: Vec<u8>,
}

impl LifecycleEvent {
    /// Validate untrusted adapter data against a host-supplied slot and explicit limits.
    /// The snapshot's own slot is never treated as the current execution slot.
    pub fn validate(
        &self,
        context: ExecutionContext,
        policy: &EventValidationPolicy,
    ) -> Result<(), EventValidationError> {
        if policy.max_ltv_bps > 10_000 || policy.max_oracle_confidence_bps > 10_000 {
            return Err(EventValidationError::InvalidValidationPolicy);
        }
        if self.market.slot > context.current_slot {
            return Err(EventValidationError::FutureMarketSnapshot);
        }
        let event_age = context.current_slot - self.market.slot;
        if event_age > policy.max_event_age_slots {
            return Err(EventValidationError::StaleMarketSnapshot {
                age: event_age,
                maximum: policy.max_event_age_slots,
            });
        }
        if self.payload.len() > policy.max_payload_bytes {
            return Err(EventValidationError::PayloadTooLarge {
                size: self.payload.len(),
                maximum: policy.max_payload_bytes,
            });
        }
        if self.position.ltv_bps > policy.max_ltv_bps {
            return Err(EventValidationError::LtvOutOfRange);
        }
        if self.position.liquidation_threshold_bps > 10_000 || self.market.utilisation_bps > 10_000
        {
            return Err(EventValidationError::BasisPointsOutOfRange);
        }
        if self.market.oracle_points.len() > policy.max_oracle_points {
            return Err(EventValidationError::TooManyOraclePoints);
        }

        let mut seen_mints = HashSet::with_capacity(self.market.oracle_points.len());
        for point in &self.market.oracle_points {
            if !seen_mints.insert(point.mint) {
                return Err(EventValidationError::DuplicateOracleMint(point.mint));
            }
            if point.slot > self.market.slot {
                return Err(EventValidationError::FutureOracleObservation);
            }
            let age = context.current_slot - point.slot;
            if age > policy.max_oracle_age_slots {
                return Err(EventValidationError::StaleOracleObservation {
                    mint: point.mint,
                    age,
                    maximum: policy.max_oracle_age_slots,
                });
            }
            if point.price_e8 == 0
                || (point.confidence_e8 as u128) * 10_000
                    > (point.price_e8 as u128) * (policy.max_oracle_confidence_bps as u128)
            {
                return Err(EventValidationError::InvalidOracleObservation { mint: point.mint });
            }
        }
        Ok(())
    }
}

#[derive(
    Copy,
    Clone,
    Debug,
    PartialEq,
    Eq,
    Hash,
    BorshSerialize,
    BorshDeserialize,
    Serialize,
    Deserialize,
)]
pub enum AdapterKind {
    Marginfi,
    Kamino,
    Solend,
}

impl AdapterKind {
    pub fn program_id(self) -> [u8; 32] {
        match self {
            // Marginfi v2: MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA
            Self::Marginfi => decode32("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"),
            // Kamino Lend: KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD
            Self::Kamino => decode32("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
            // Solend mainnet: So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo
            Self::Solend => decode32("So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo"),
        }
    }
}

const BASE58_ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const fn decode32(s: &str) -> [u8; 32] {
    let bytes = s.as_bytes();
    let mut decoded = [0u8; 32];
    let mut decoded_len: usize = 0;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        let mut idx: i32 = -1;
        let mut j = 0;
        while j < BASE58_ALPHABET.len() {
            if BASE58_ALPHABET[j] == c {
                idx = j as i32;
                break;
            }
            j += 1;
        }
        if idx < 0 {
            i += 1;
            continue;
        }
        let mut carry = idx as u32;
        let mut k = 0;
        while k < decoded.len() {
            carry += (decoded[k] as u32) * 58;
            decoded[k] = (carry & 0xff) as u8;
            carry >>= 8;
            k += 1;
        }
        let mut leading = 0;
        let mut k2 = decoded.len();
        while k2 > 0 {
            k2 -= 1;
            if decoded[k2] != 0 {
                leading = k2 + 1;
                break;
            }
        }
        if leading > decoded_len {
            decoded_len = leading;
        }
        i += 1;
    }
    let mut out = [0u8; 32];
    let mut k = 0;
    while k < decoded_len && k < 32 {
        out[k] = decoded[decoded_len - 1 - k];
        k += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_label_round_trip() {
        for k in [
            LifecycleEventKind::BeforeDeposit,
            LifecycleEventKind::AfterDeposit,
            LifecycleEventKind::BeforeBorrow,
            LifecycleEventKind::AfterBorrow,
            LifecycleEventKind::BeforeRepay,
            LifecycleEventKind::AfterRepay,
            LifecycleEventKind::BeforeLiquidate,
            LifecycleEventKind::AfterLiquidate,
        ] {
            assert!(k
                .label()
                .starts_with(if k.is_before() { "before" } else { "after" }));
        }
    }

    #[test]
    fn health_factor_handles_zero_ltv() {
        let p = PositionSnapshot {
            owner: [0; 32],
            collateral_mint: [0; 32],
            debt_mint: [0; 32],
            collateral_amount: 100,
            debt_amount: 0,
            ltv_bps: 0,
            liquidation_threshold_bps: 8000,
        };
        assert_eq!(p.health_factor_bps(), u32::MAX);
    }

    #[test]
    fn adapter_program_ids_decode() {
        for a in [
            AdapterKind::Marginfi,
            AdapterKind::Kamino,
            AdapterKind::Solend,
        ] {
            let pid = a.program_id();
            assert!(pid.iter().any(|b| *b != 0), "{a:?} pid all zero");
        }
    }

    fn event_at(slot: u64) -> LifecycleEvent {
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
                slot,
                timestamp: 0,
                oracle_points: Vec::new(),
                realised_vol_bps: 200,
                utilisation_bps: 5_000,
            },
            payload: Vec::new(),
        }
    }

    #[test]
    fn validation_uses_trusted_current_slot_and_bounds() {
        let policy = EventValidationPolicy::default();
        assert_eq!(
            event_at(120).validate(ExecutionContext { current_slot: 100 }, &policy),
            Err(EventValidationError::FutureMarketSnapshot)
        );
        assert!(matches!(
            event_at(100).validate(ExecutionContext { current_slot: 251 }, &policy),
            Err(EventValidationError::StaleMarketSnapshot { age: 151, .. })
        ));
        let mut oversized = event_at(100);
        oversized.payload = vec![0; 257];
        assert!(matches!(
            oversized.validate(ExecutionContext { current_slot: 100 }, &policy),
            Err(EventValidationError::PayloadTooLarge { .. })
        ));
    }

    #[test]
    fn oracle_observations_are_bounded_and_unique() {
        let policy = EventValidationPolicy::default();
        let point = OraclePoint {
            mint: [2; 32],
            price_e8: 10_000,
            confidence_e8: 100,
            slot: 98,
        };
        let mut event = event_at(100);
        event.market.oracle_points = vec![point, point];
        assert!(matches!(
            event.validate(ExecutionContext { current_slot: 100 }, &policy),
            Err(EventValidationError::DuplicateOracleMint(_))
        ));
        event.market.oracle_points = vec![OraclePoint { slot: 90, ..point }];
        let strict_policy = EventValidationPolicy {
            max_oracle_age_slots: 5,
            ..policy
        };
        assert!(matches!(
            event.validate(ExecutionContext { current_slot: 100 }, &strict_policy),
            Err(EventValidationError::StaleOracleObservation { age: 10, .. })
        ));
    }
}
