//! Error codes for the HUKT transfer-hook program.
//!
//! Every preset maps a validation failure to a distinct, greppable variant so
//! wallets/DEX integrators can surface a precise reason to the user.

use anchor_lang::prelude::*;

#[error_code]
pub enum HookError {
    #[msg("Transfer is not allowed by this hook")]
    TransferNotAllowed,
    #[msg("Hook invoked outside of a real Token-2022 transfer")]
    NotTransferring,
    #[msg("Amount exceeds the per-wallet limit")]
    LimitExceeded,
    #[msg("Destination owner is not on the whitelist")]
    NotWhitelisted,
    #[msg("Source owner is on the blacklist")]
    Blacklisted,
    #[msg("Tokens are still locked by the vesting schedule")]
    StillLocked,
    #[msg("Sender is still within the anti-bot cooldown window")]
    CooldownActive,
    #[msg("Anti-bot cooldown account is missing or not initialized")]
    CooldownNotReady,
    #[msg("KYC attestation is missing, revoked, or expired")]
    KycInvalid,
    #[msg("Royalty has not been paid for this transfer")]
    RoyaltyUnpaid,
    #[msg("Royalty configuration account is missing")]
    RoyaltyConfigMissing,
    #[msg("Fee configuration or vault account is missing")]
    FeeConfigMissing,
    #[msg("Transfer violates the fee-on-transfer policy")]
    FeePolicyViolation,
    #[msg("Preset mask does not match the stored hook configuration")]
    PresetMismatch,
    #[msg("A required extra account was not supplied to the hook")]
    MissingExtraAccount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Signer is not the configured authority")]
    Unauthorized,
}
