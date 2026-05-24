//! Transfer-hook validation logic.
//!
//! `run_transfer_hook` first enforces the Token-2022 "transferring" security
//! gate, then walks the active presets in `PRESET_ORDER`, consuming the extra
//! accounts in the exact order `meta::build_extra_metas` produced them.

use anchor_lang::prelude::*;

use crate::errors::HookError;
use crate::meta::PRESET_ORDER;
use crate::state::{
    mask_has, BlacklistEntry, CooldownState, FeeConfig, FeeVault, HookConfig, HookPreset,
    KycAttestation, RoyaltyConfig, RoyaltyReceipt, SoulboundException, VestingState,
    WhitelistEntry,
};

/// Basis-points denominator.
const BPS_DENOMINATOR: u128 = 10_000;

/// Reject invocations that are not part of a live Token-2022 transfer.
///
/// Token-2022 flips the source account's `TransferHookAccount.transferring`
/// flag true only for the duration of a transfer CPI, so a direct Execute call
/// (which could otherwise poison writable state PDAs) fails here.
pub fn assert_transferring(source: &AccountInfo) -> Result<()> {
    use anchor_spl::token_2022::spl_token_2022::extension::{
        transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions,
    };
    use anchor_spl::token_2022::spl_token_2022::state::Account as Token2022Account;

    let data = source.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Account>::unpack(&data)
        .map_err(|_| error!(HookError::NotTransferring))?;
    let ext = state
        .get_extension::<TransferHookAccount>()
        .map_err(|_| error!(HookError::NotTransferring))?;
    require!(bool::from(ext.transferring), HookError::NotTransferring);
    Ok(())
}

/// Pull the next extra account and advance the cursor.
fn next<'a, 'info>(
    extras: &'a [AccountInfo<'info>],
    cursor: &mut usize,
) -> Result<&'a AccountInfo<'info>> {
    let account = extras
        .get(*cursor)
        .ok_or(error!(HookError::MissingExtraAccount))?;
    *cursor = cursor.saturating_add(1);
    Ok(account)
}

/// Read a program-owned HUKT account, returning `Some(T)` only when the account
/// exists, is owned by this program, and deserializes cleanly. Uninitialized or
/// foreign accounts yield `None` (used for presence-based presets).
fn load_owned<T: AccountDeserialize>(account: &AccountInfo, program_id: &Pubkey) -> Option<T> {
    if account.owner != program_id || account.data_is_empty() {
        return None;
    }
    let data = account.try_borrow_data().ok()?;
    T::try_deserialize(&mut &data[..]).ok()
}

/// Serialize `value` back into a writable, program-owned account.
fn store_owned<T: AccountSerialize>(account: &AccountInfo, value: &T) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let mut writer: &mut [u8] = &mut data[..];
    value.try_serialize(&mut writer)?;
    Ok(())
}

/// Validate a live transfer against every active preset for the mint.
pub fn run_transfer_hook(
    program_id: &Pubkey,
    source: &AccountInfo,
    amount: u64,
    config: &HookConfig,
    extras: &[AccountInfo],
) -> Result<()> {
    assert_transferring(source)?;

    let mut cursor: usize = 0;
    for preset in PRESET_ORDER {
        if !mask_has(config.presets_mask, preset) {
            continue;
        }
        match preset {
            HookPreset::Royalty => validate_royalty(program_id, amount, extras, &mut cursor)?,
            HookPreset::Whitelist => validate_whitelist(program_id, extras, &mut cursor)?,
            HookPreset::Blacklist => validate_blacklist(program_id, extras, &mut cursor)?,
            HookPreset::Vesting => validate_vesting(program_id, extras, &mut cursor)?,
            HookPreset::AntiBot => {
                validate_antibot(program_id, amount, config, extras, &mut cursor)?
            }
            HookPreset::KYCGate => validate_kyc(config, extras, &mut cursor)?,
            HookPreset::FeeOnTransfer => {
                validate_fee_on_transfer(program_id, amount, extras, &mut cursor)?
            }
            HookPreset::Soulbound => validate_soulbound(program_id, extras, &mut cursor)?,
        }
    }
    Ok(())
}

fn validate_royalty(
    program_id: &Pubkey,
    amount: u64,
    extras: &[AccountInfo],
    cursor: &mut usize,
) -> Result<()> {
    let config_ai = next(extras, cursor)?;
    let receipt_ai = next(extras, cursor)?;

    let config: RoyaltyConfig =
        load_owned(config_ai, program_id).ok_or(error!(HookError::RoyaltyConfigMissing))?;
    if !config.enforced {
        return Ok(());
    }
    // A hook cannot move tokens; it verifies that an approved marketplace/escrow
    // already recorded a royalty receipt covering this transfer. Actual value
    // movement happens in that escrow or via the Token-2022 TransferFee extension.
    let receipt: RoyaltyReceipt =
        load_owned(receipt_ai, program_id).ok_or(error!(HookError::RoyaltyUnpaid))?;
    let expected = (amount as u128)
        .checked_mul(config.royalty_bps as u128)
        .ok_or(HookError::MathOverflow)?
        / BPS_DENOMINATOR;
    require!(
        (receipt.amount_paid as u128) >= expected,
        HookError::RoyaltyUnpaid
    );
    Ok(())
}

fn validate_whitelist(
    program_id: &Pubkey,
    extras: &[AccountInfo],
    cursor: &mut usize,
) -> Result<()> {
    let entry_ai = next(extras, cursor)?;
    let entry: WhitelistEntry =
        load_owned(entry_ai, program_id).ok_or(error!(HookError::NotWhitelisted))?;
    require!(entry.allowed, HookError::NotWhitelisted);
    Ok(())
}

fn validate_blacklist(
    program_id: &Pubkey,
    extras: &[AccountInfo],
    cursor: &mut usize,
) -> Result<()> {
    let entry_ai = next(extras, cursor)?;
    // Absent entry => sender is not blacklisted => allow.
    if let Some(entry) = load_owned::<BlacklistEntry>(entry_ai, program_id) {
        require!(!entry.blocked, HookError::Blacklisted);
    }
    Ok(())
}

fn validate_vesting(program_id: &Pubkey, extras: &[AccountInfo], cursor: &mut usize) -> Result<()> {
    let state_ai = next(extras, cursor)?;
    let clock_ai = next(extras, cursor)?;
    let now = Clock::from_account_info(clock_ai)?.unix_timestamp;
    // No schedule for this owner => nothing is locked => allow.
    if let Some(state) = load_owned::<VestingState>(state_ai, program_id) {
        require!(now >= state.unlock_ts, HookError::StillLocked);
    }
    Ok(())
}

fn validate_antibot(
    program_id: &Pubkey,
    amount: u64,
    config: &HookConfig,
    extras: &[AccountInfo],
    cursor: &mut usize,
) -> Result<()> {
    let state_ai = next(extras, cursor)?;
    let clock_ai = next(extras, cursor)?;
    let now = Clock::from_account_info(clock_ai)?.unix_timestamp;

    // The cooldown account must be pre-registered (writable, program-owned) so
    // the hook can persist the updated timestamp/accumulator.
    let mut state: CooldownState =
        load_owned(state_ai, program_id).ok_or(error!(HookError::CooldownNotReady))?;
    require!(state_ai.is_writable, HookError::CooldownNotReady);

    require!(amount <= config.per_wallet_limit, HookError::LimitExceeded);
    if state.last_ts != 0 {
        let elapsed = now
            .checked_sub(state.last_ts)
            .ok_or(HookError::MathOverflow)?;
        require!(elapsed >= config.cooldown_secs, HookError::CooldownActive);
    }
    state.last_ts = now;
    state.accumulated = state
        .accumulated
        .checked_add(amount)
        .ok_or(HookError::MathOverflow)?;
    store_owned(state_ai, &state)?;
    Ok(())
}

fn validate_kyc(config: &HookConfig, extras: &[AccountInfo], cursor: &mut usize) -> Result<()> {
    let gatekeeper_ai = next(extras, cursor)?;
    let attestation_ai = next(extras, cursor)?;
    require!(
        gatekeeper_ai.key() == config.gatekeeper,
        HookError::KycInvalid
    );
    // Attestation is owned by the (possibly third-party) gatekeeper program, so
    // deserialize owner-agnostically rather than via Anchor's owner check.
    require!(
        attestation_ai.owner == &config.gatekeeper && !attestation_ai.data_is_empty(),
        HookError::KycInvalid
    );
    let data = attestation_ai.try_borrow_data()?;
    let attestation = KycAttestation::try_deserialize(&mut &data[..])
        .map_err(|_| error!(HookError::KycInvalid))?;
    let now = Clock::get()?.unix_timestamp;
    require!(!attestation.revoked, HookError::KycInvalid);
    require!(attestation.expiry > now, HookError::KycInvalid);
    Ok(())
}

fn validate_fee_on_transfer(
    program_id: &Pubkey,
    amount: u64,
    extras: &[AccountInfo],
    cursor: &mut usize,
) -> Result<()> {
    let config_ai = next(extras, cursor)?;
    let vault_ai = next(extras, cursor)?;

    let config: FeeConfig =
        load_owned(config_ai, program_id).ok_or(error!(HookError::FeeConfigMissing))?;
    require!(!config.paused, HookError::FeePolicyViolation);
    require!(amount >= config.min_transfer, HookError::FeePolicyViolation);

    // The hook records the fee it *would* owe; the Token-2022 TransferFee
    // extension performs the actual withhold. A hook cannot move tokens.
    require!(vault_ai.is_writable, HookError::FeeConfigMissing);
    let mut vault: FeeVault =
        load_owned(vault_ai, program_id).ok_or(error!(HookError::FeeConfigMissing))?;
    let fee = ((amount as u128)
        .checked_mul(config.fee_bps as u128)
        .ok_or(HookError::MathOverflow)?
        / BPS_DENOMINATOR) as u64;
    vault.total_fees_recorded = vault
        .total_fees_recorded
        .checked_add(fee)
        .ok_or(HookError::MathOverflow)?;
    vault.transfer_count = vault
        .transfer_count
        .checked_add(1)
        .ok_or(HookError::MathOverflow)?;
    store_owned(vault_ai, &vault)?;
    Ok(())
}

fn validate_soulbound(
    program_id: &Pubkey,
    extras: &[AccountInfo],
    cursor: &mut usize,
) -> Result<()> {
    let exception_ai = next(extras, cursor)?;
    match load_owned::<SoulboundException>(exception_ai, program_id) {
        Some(exception) if exception.allowed => Ok(()),
        _ => err!(HookError::TransferNotAllowed),
    }
}
