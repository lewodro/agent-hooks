use anchor_lang::prelude::*;

#[account]
pub struct Pool {
    pub authority: Pubkey,
    pub market: Pubkey,
    /// 0 = Marginfi, 1 = Kamino, 2 = Solend.
    pub adapter: u8,
    pub composition_count: u32,
    pub bump: u8,
}

impl Pool {
    pub const SPACE: usize = 32 + 32 + 1 + 4 + 1;
}

#[account]
pub struct Composition {
    pub pool: Pubkey,
    pub slot_index: u8,
    pub installed_at: i64,
    pub entries: Vec<HookEntry>,
    pub bump: u8,
}

impl Composition {
    /// 32 (pool) + 1 (slot_index) + 8 (installed_at) + 4 (vec prefix) +
    /// 8 * (32 + 2 + 2) (max 8 entries) + 1 (bump) = 333 bytes.
    pub const SPACE: usize = 32 + 1 + 8 + 4 + 8 * (32 + 2 + 2) + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct HookEntry {
    pub hook_program: Pubkey,
    pub priority: u16,
    pub flags: HookFlagsBitmap,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default)]
pub struct HookFlagsBitmap {
    pub bits: u16,
}

#[account]
pub struct HookListing {
    pub hook_program: Pubkey,
    pub author: Pubkey,
    pub flags: HookFlagsBitmap,
    pub manifest_uri: String,
    pub published_at: i64,
    pub bump: u8,
}

impl HookListing {
    /// 32 + 32 + 2 + (4 + 200) + 8 + 1 = 279.
    pub const SPACE: usize = 32 + 32 + 2 + 4 + 200 + 8 + 1;
}
