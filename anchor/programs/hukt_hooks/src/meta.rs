//! ExtraAccountMetaList construction.
//!
//! `build_extra_metas` turns a mint's `HookConfig` into the exact ordered list
//! of accounts Token-2022 must append to every Execute CPI. `meta_count` returns
//! the same length from the mask alone so it can size the PDA at `init` time
//! (before the config is deserialized). The two MUST agree, and the ordering
//! here is the contract `hooks::run_transfer_hook` consumes in lockstep.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar;
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed};

use crate::state::{
    mask_has, HookConfig, HookPreset, BLACKLIST_SEED, COOLDOWN_SEED, FEE_CONFIG_SEED,
    FEE_VAULT_SEED, HOOK_CONFIG_SEED, KYC_SEED, ROYALTY_RECEIPT_SEED, ROYALTY_SEED,
    SOULBOUND_EXC_SEED, VESTING_SEED, WHITELIST_SEED,
};

/// Canonical preset ordering for both meta construction and validation.
pub const PRESET_ORDER: [HookPreset; 8] = [
    HookPreset::Royalty,
    HookPreset::Whitelist,
    HookPreset::Blacklist,
    HookPreset::Vesting,
    HookPreset::AntiBot,
    HookPreset::KYCGate,
    HookPreset::FeeOnTransfer,
    HookPreset::Soulbound,
];

/// Number of extra accounts a single preset contributes.
pub const fn preset_meta_count(preset: HookPreset) -> usize {
    match preset {
        HookPreset::Royalty => 2,       // config + receipt
        HookPreset::Whitelist => 1,     // entry
        HookPreset::Blacklist => 1,     // entry
        HookPreset::Vesting => 2,       // state + clock
        HookPreset::AntiBot => 2,       // state + clock
        HookPreset::KYCGate => 2,       // gatekeeper program + attestation
        HookPreset::FeeOnTransfer => 2, // config + vault
        HookPreset::Soulbound => 1,     // exception
    }
}

/// Total extra accounts for a mask: the always-present HookConfig plus each
/// active preset's accounts.
pub fn meta_count(mask: u8) -> usize {
    let mut n = 1; // HookConfig is always extra account index 5
    for preset in PRESET_ORDER {
        if mask_has(mask, preset) {
            n += preset_meta_count(preset);
        }
    }
    n
}

fn literal(seed: &[u8]) -> Seed {
    Seed::Literal {
        bytes: seed.to_vec(),
    }
}

/// Build the ordered ExtraAccountMeta list for a mint from its config.
///
/// Account indices in the full Execute list: 0 source, 1 mint, 2 destination,
/// 3 authority, 4 validation, 5 HookConfig, 6.. preset accounts.
pub fn build_extra_metas(config: &HookConfig) -> Result<Vec<ExtraAccountMeta>> {
    let mut metas: Vec<ExtraAccountMeta> = Vec::with_capacity(meta_count(config.presets_mask));

    // Index 5: HookConfig PDA [b"hook-config", mint]. Read-only.
    metas.push(ExtraAccountMeta::new_with_seeds(
        &[literal(HOOK_CONFIG_SEED), Seed::AccountKey { index: 1 }],
        false,
        false,
    )?);

    for preset in PRESET_ORDER {
        if !mask_has(config.presets_mask, preset) {
            continue;
        }
        match preset {
            HookPreset::Royalty => {
                // [b"royalty", mint] config
                metas.push(ExtraAccountMeta::new_with_seeds(
                    &[literal(ROYALTY_SEED), Seed::AccountKey { index: 1 }],
                    false,
                    false,
                )?);
                // [b"royalty-receipt", mint, source_owner] receipt
                metas.push(ExtraAccountMeta::new_with_seeds(
                    &[
                        literal(ROYALTY_RECEIPT_SEED),
                        Seed::AccountKey { index: 1 },
                        Seed::AccountData {
                            account_index: 0,
                            data_index: 32,
                            length: 32,
                        },
                    ],
                    false,
                    false,
                )?);
            }
            HookPreset::Whitelist => {
                // [b"whitelist", destination_owner]
                metas.push(ExtraAccountMeta::new_with_seeds(
                    &[
                        literal(WHITELIST_SEED),
                        Seed::AccountData {
                            account_index: 2,
                            data_index: 32,
                            length: 32,
                        },
                    ],
                    false,
                    false,
                )?);
            }
            HookPreset::Blacklist => {
                // [b"blacklist", source_owner]
                metas.push(ExtraAccountMeta::new_with_seeds(
                    &[
                        literal(BLACKLIST_SEED),
                        Seed::AccountData {
                            account_index: 0,
                            data_index: 32,
                            length: 32,
                        },
                    ],
                    false,
                    false,
                )?);
            }
            HookPreset::Vesting => {
                // [b"vesting", mint, source_owner]
                metas.push(ExtraAccountMeta::new_with_seeds(
                    &[
                        literal(VESTING_SEED),
                        Seed::AccountKey { index: 1 },
                        Seed::AccountData {
                            account_index: 0,
                            data_index: 32,
                            length: 32,
                        },
                    ],
                    false,
                    false,
                )?);
                // Clock sysvar
                metas.push(ExtraAccountMeta::new_with_pubkey(
                    &sysvar::clock::ID,
                    false,
                    false,
                )?);
            }
            HookPreset::AntiBot => {
                // [b"cooldown", mint, source_owner] -- writable, hook updates it
                metas.push(ExtraAccountMeta::new_with_seeds(
                    &[
                        literal(COOLDOWN_SEED),
                        Seed::AccountKey { index: 1 },
                        Seed::AccountData {
                            account_index: 0,
                            data_index: 32,
                            length: 32,
                        },
                    ],
                    false,
                    true,
                )?);
                metas.push(ExtraAccountMeta::new_with_pubkey(
                    &sysvar::clock::ID,
                    false,
                    false,
                )?);
            }
            HookPreset::KYCGate => {
                // The gatekeeper program account anchors the external-PDA derive.
                // Its position in the full list = 5 base/config metas already
                // pushed + the length accumulated so far.
                let program_index = (metas.len() + 5) as u8;
                metas.push(ExtraAccountMeta::new_with_pubkey(
                    &config.gatekeeper,
                    false,
                    false,
                )?);
                // Attestation PDA [b"kyc", destination_owner] owned by gatekeeper.
                metas.push(ExtraAccountMeta::new_external_pda_with_seeds(
                    program_index,
                    &[
                        literal(KYC_SEED),
                        Seed::AccountData {
                            account_index: 2,
                            data_index: 32,
                            length: 32,
                        },
                    ],
                    false,
                    false,
                )?);
            }
            HookPreset::FeeOnTransfer => {
                // [b"fee-config", mint] read-only
                metas.push(ExtraAccountMeta::new_with_seeds(
                    &[literal(FEE_CONFIG_SEED), Seed::AccountKey { index: 1 }],
                    false,
                    false,
                )?);
                // [b"fee-vault", mint] writable accounting
                metas.push(ExtraAccountMeta::new_with_seeds(
                    &[literal(FEE_VAULT_SEED), Seed::AccountKey { index: 1 }],
                    false,
                    true,
                )?);
            }
            HookPreset::Soulbound => {
                // [b"soulbound-exc", source_owner] exception list entry
                metas.push(ExtraAccountMeta::new_with_seeds(
                    &[
                        literal(SOULBOUND_EXC_SEED),
                        Seed::AccountData {
                            account_index: 0,
                            data_index: 32,
                            length: 32,
                        },
                    ],
                    false,
                    false,
                )?);
            }
        }
    }

    Ok(metas)
}
