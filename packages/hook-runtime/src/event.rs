//! Lifecycle events that flow through the hook runtime.

use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};

/// Discrete points in the loan lifecycle at which a hook may run.
///
/// Modelled after Aave v3's pre/post action hooks and Uniswap v4's beforeSwap/afterSwap
/// pair, mapped onto the four core lending actions: deposit, borrow, repay, liquidate.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
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
#[derive(Copy, Clone, Debug, BorshSerialize, BorshDeserialize, Serialize, Deserialize, PartialEq)]
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

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, BorshSerialize, BorshDeserialize, Serialize, Deserialize)]
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
        let mut carry: u32 = 0;
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
        carry = idx as u32;
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
            assert!(k.label().starts_with(if k.is_before() { "before" } else { "after" }));
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
        for a in [AdapterKind::Marginfi, AdapterKind::Kamino, AdapterKind::Solend] {
            let pid = a.program_id();
            assert!(pid.iter().any(|b| *b != 0), "{a:?} pid all zero");
        }
    }
}
