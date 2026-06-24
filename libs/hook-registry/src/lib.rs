//! HUKT hook registry -- shared types for the on-chain registry of deployed
//! transfer hooks and their safety attestations. The Anchor accounts that
//! persist this state live in the anchor-program crate; this crate holds the
//! taxonomy and the pure malicious-pattern scoring attestors apply.

/// Outcome of scanning a deployed hook for known dangerous patterns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttestationStatus {
    /// Reviewed and considered safe to integrate.
    Safe,
    /// Reviewed; carries risk an integrator must acknowledge.
    Caution,
    /// Known transfer-blocking or fund-draining behaviour.
    Malicious,
    /// Not yet attested.
    Unknown,
}

/// A dangerous behaviour an attestor scans a hook for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RiskFlag {
    /// Hook can make transfers permanently fail (freeze funds).
    TransferBlock,
    /// Hook can redirect balances to an arbitrary account.
    BalanceDrain,
    /// Hook writes to accounts outside the resolved ExtraAccountMetaList.
    UnexpectedWrite,
}

/// Derive an attestation status from the risk flags an attestor found.
pub fn status_from_flags(flags: &[RiskFlag]) -> AttestationStatus {
    if flags.is_empty() {
        return AttestationStatus::Safe;
    }
    if flags
        .iter()
        .any(|f| matches!(f, RiskFlag::TransferBlock | RiskFlag::BalanceDrain))
    {
        return AttestationStatus::Malicious;
    }
    AttestationStatus::Caution
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_flags_is_safe() {
        assert_eq!(status_from_flags(&[]), AttestationStatus::Safe);
    }

    #[test]
    fn drain_is_malicious() {
        assert_eq!(
            status_from_flags(&[RiskFlag::BalanceDrain]),
            AttestationStatus::Malicious
        );
    }

    #[test]
    fn unexpected_write_is_caution() {
        assert_eq!(
            status_from_flags(&[RiskFlag::UnexpectedWrite]),
            AttestationStatus::Caution
        );
    }
}
