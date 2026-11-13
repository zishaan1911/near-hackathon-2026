//! Pure margin and PnL math. Holds no state; every function is deterministic.

/// Basis-point denominator: a margin ratio of 1000 bps is 10% of notional.
pub const BPS_DENOMINATOR: u128 = 10_000;

/// Notional value of `quantity` contracts at `price`, in token base units.
pub fn notional(price: u64, quantity: u64, contract_multiplier: u64) -> u128 {
    assert!(contract_multiplier > 0, "contract multiplier must be positive");
    (price as u128)
        .checked_mul(quantity as u128)
        .and_then(|n| n.checked_mul(contract_multiplier as u128))
        .expect("notional overflow")
}

/// Required initial margin: `margin_ratio_bps / 10_000` of notional.
/// `margin_ratio_bps` must be in `(0, 10_000]`.
pub fn required_margin(price: u64, quantity: u64, contract_multiplier: u64, margin_ratio_bps: u64) -> u128 {
    assert!(
        margin_ratio_bps > 0 && (margin_ratio_bps as u128) <= BPS_DENOMINATOR,
        "margin ratio out of range"
    );
    notional(price, quantity, contract_multiplier) * (margin_ratio_bps as u128) / BPS_DENOMINATOR
}

/// PnL for `quantity` contracts moving from `entry_price` to `exit_price`:
/// `Long P&L = (final - entry) * contract_multiplier * quantity`.
/// Returns `(magnitude, is_negative)`; a flat position returns `(0, false)`.
pub fn compute_pnl(
    is_long: bool,
    entry_price: u64,
    exit_price: u64,
    quantity: u64,
    contract_multiplier: u64,
) -> (u128, bool) {
    assert!(contract_multiplier > 0, "contract multiplier must be positive");
    let favorable = if is_long { exit_price >= entry_price } else { entry_price >= exit_price };
    let diff = if is_long {
        exit_price.abs_diff(entry_price)
    } else {
        entry_price.abs_diff(exit_price)
    };
    let magnitude = (diff as u128)
        .checked_mul(quantity as u128)
        .and_then(|n| n.checked_mul(contract_multiplier as u128))
        .expect("pnl overflow");
    (magnitude, !favorable)
}

/// Payout for one side of a settled trade (capped model): a winner receives their own committed margin plus PnL,
/// capped at the *other* side's committed margin; a loser receives their own
/// committed margin minus PnL, floored at zero. The two payouts always sum to
/// the two commitments, so claims can never overdraw.
pub fn payout(committed: u128, other_committed: u128, pnl_magnitude: u128, pnl_is_negative: bool) -> u128 {
    if pnl_is_negative {
        committed - pnl_magnitude.min(committed)
    } else {
        committed + pnl_magnitude.min(other_committed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn margin_is_ratio_of_notional() {
        // 300 * 25 * 10_000 = 75_000_000 notional, 10% = 7_500_000
        assert_eq!(notional(300, 25, 10_000), 75_000_000);
        assert_eq!(required_margin(300, 25, 10_000, 1_000), 7_500_000);
    }

    #[test]
    #[should_panic(expected = "margin ratio out of range")]
    fn zero_margin_ratio_rejected() {
        required_margin(1, 1, 1, 0);
    }

    #[test]
    #[should_panic(expected = "margin ratio out of range")]
    fn margin_ratio_above_100_percent_rejected() {
        required_margin(1, 1, 1, 10_001);
    }

    #[test]
    fn pnl_long_and_short() {
        assert_eq!(compute_pnl(true, 300, 320, 10, 5), (1_000, false));
        assert_eq!(compute_pnl(true, 300, 280, 10, 5), (1_000, true));
        assert_eq!(compute_pnl(false, 300, 280, 10, 5), (1_000, false));
        assert_eq!(compute_pnl(false, 300, 320, 10, 5), (1_000, true));
        assert_eq!(compute_pnl(true, 300, 300, 10, 5), (0, false));
        assert_eq!(compute_pnl(false, 300, 300, 10, 5), (0, false));
    }

    #[test]
    fn payout_is_capped_and_conserves_escrow() {
        // winner gain capped at the other side's commitment
        assert_eq!(payout(100, 40, 1_000, false), 140);
        // loser floored at zero
        assert_eq!(payout(40, 100, 1_000, true), 0);
        // uncapped case: sums to total escrow
        let (a, b) = (100u128, 60u128);
        assert_eq!(payout(a, b, 25, false) + payout(b, a, 25, true), a + b);
        // capped case: still sums to total escrow
        assert_eq!(payout(a, b, 1_000, false) + payout(b, a, 1_000, true), a + b);
    }
}
