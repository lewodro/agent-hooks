use anchor_lang::prelude::*;

#[error_code]
pub enum HookExecutorError {
    #[msg("Adapter byte must be 0 (Marginfi), 1 (Kamino) or 2 (Solend).")]
    UnknownAdapter,

    #[msg("Composition would exceed MAX_HOOKS_PER_COMPOSITION (8).")]
    TooManyHooks,

    #[msg("Composition must contain at least one hook entry.")]
    EmptyComposition,

    #[msg("Authority signer does not match the pool's recorded authority.")]
    AuthorityMismatch,

    #[msg("Composition belongs to a different pool.")]
    CompositionPoolMismatch,

    #[msg("Unknown event_kind byte (must be 0..7).")]
    UnknownEventKind,

    #[msg("Caller's reported adapter does not match the registered pool adapter.")]
    AdapterMismatch,

    #[msg("Caller payload exceeds 256 bytes.")]
    PayloadTooLarge,

    #[msg("Hook listing must declare at least one flag bit.")]
    EmptyFlags,

    #[msg("Manifest URI exceeds 200 bytes.")]
    ManifestUriTooLong,

    #[msg("Composition entries must each carry a unique priority value.")]
    DuplicatePriority,
}
