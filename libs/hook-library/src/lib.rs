//! HUKT hook library -- the catalogue of verified, composable transfer-hook
//! presets. Each preset maps to a set of on-chain checks the transfer hook runs;
//! this crate holds the shared taxonomy and the pure parameter math so both the
//! Anchor program and the tooling agree on preset identity and behaviour.

/// The eight presets shipped by HUKT. They are composable on a single mint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookKind {
    Royalty,
    Whitelist,
    Blacklist,
    Vesting,
    AntiBot,
    KycGate,
    FeeOnTransfer,
    Soulbound,
}

impl HookKind {
    pub const ALL: [HookKind; 8] = [
        HookKind::Royalty,
        HookKind::Whitelist,
        HookKind::Blacklist,
        HookKind::Vesting,
        HookKind::AntiBot,
        HookKind::KycGate,
        HookKind::FeeOnTransfer,
        HookKind::Soulbound,
    ];

    pub fn slug(&self) -> &'static str {
        match self {
            HookKind::Royalty => "royalty",
            HookKind::Whitelist => "whitelist",
            HookKind::Blacklist => "blacklist",
            HookKind::Vesting => "vesting",
            HookKind::AntiBot => "antibot",
            HookKind::KycGate => "kycgate",
            HookKind::FeeOnTransfer => "fee-on-transfer",
            HookKind::Soulbound => "soulbound",
        }
    }

    /// Parse a preset slug back into its `HookKind`, the inverse of
    /// [`slug`](HookKind::slug). Returns `None` for an unrecognized slug so the
    /// CLI and SDK can reject unknown preset names instead of panicking.
    pub fn from_slug(slug: &str) -> Option<HookKind> {
        HookKind::ALL.into_iter().find(|kind| kind.slug() == slug)
    }
}

/// Basis-point royalty preset. `bps` is capped at 100% (10_000 bps).
#[derive(Clone, Copy, Debug)]
pub struct RoyaltyParams {
    pub bps: u16,
}

impl RoyaltyParams {
    pub fn new(bps: u16) -> Self {
        Self {
            bps: bps.min(10_000),
        }
    }

    /// Royalty owed on a transfer of `amount`, rounded down.
    pub fn royalty_on(&self, amount: u64) -> u64 {
        (amount as u128 * self.bps as u128 / 10_000) as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn royalty_math() {
        let r = RoyaltyParams::new(500); // 5%
        assert_eq!(r.royalty_on(1_000), 50);
    }

    #[test]
    fn royalty_is_capped() {
        assert_eq!(RoyaltyParams::new(20_000).bps, 10_000);
    }

    #[test]
    fn eight_presets_exist() {
        assert_eq!(HookKind::ALL.len(), 8);
        assert_eq!(HookKind::FeeOnTransfer.slug(), "fee-on-transfer");
    }

    #[test]
    fn slug_round_trips() {
        for kind in HookKind::ALL {
            assert_eq!(HookKind::from_slug(kind.slug()), Some(kind));
        }
    }

    #[test]
    fn unknown_slug_is_none() {
        assert_eq!(HookKind::from_slug("staking"), None);
    }
}
