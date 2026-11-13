//! Unit tests against near-sdk's mocked blockchain. Cross-contract behaviour
//! (the real `ft_transfer`) is covered by the testnet rehearsal in the plan.

use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const T0_MS: u64 = 1_000_000;
const HOUR_MS: u64 = 3_600_000;
const MULT: u64 = 10_000;

fn acct(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn ctx(predecessor: &str, now_ms: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(acct(predecessor))
        .signer_account_id(acct(predecessor))
        .current_account_id(acct("silica.near"))
        .block_timestamp(now_ms * 1_000_000);
    b
}

fn set(predecessor: &str, now_ms: u64) {
    testing_env!(ctx(predecessor, now_ms).build());
}

fn new_contract() -> Contract {
    set("owner.near", T0_MS);
    Contract::new(acct("owner.near"), acct("usdc.near"), acct("pub.near"), 600_000, 1_000)
}

/// Contract with a market expiring one hour after T0, plus funded alice and bob.
fn setup() -> Contract {
    let mut c = new_contract();
    c.create_market("SCI-1H".to_string(), T0_MS + HOUR_MS, MULT, 1, 1_000);
    deposit(&mut c, "alice.near", 100_000_000);
    deposit(&mut c, "bob.near", 100_000_000);
    c
}

fn deposit(c: &mut Contract, who: &str, amount: u128) {
    set("usdc.near", T0_MS);
    c.ft_on_transfer(acct(who), U128(amount), String::new());
}

fn publish(c: &mut Contract, price: u64, now_ms: u64) {
    set("pub.near", now_ms);
    c.update_price(price);
}

/// alice bids 300, bob asks 290, qty 100. Trade at 290.
/// Margin: alice 30_000_000, bob 29_000_000.
fn matched(c: &mut Contract) -> u64 {
    set("alice.near", T0_MS + 1);
    let bid = c.place_order(true, 300, 100);
    set("bob.near", T0_MS + 2);
    let ask = c.place_order(false, 290, 100);
    set("anyone.near", T0_MS + 3);
    c.match_orders(bid, ask)
}

fn settle_at(c: &mut Contract, price: u64) {
    let t = T0_MS + HOUR_MS + 10;
    publish(c, price, t);
    set("anyone.near", t);
    c.settle_market();
}

fn bal(c: &Contract, who: &str) -> (u128, u128) {
    let a = c.get_account(acct(who));
    (a.available.0, a.locked.0)
}

#[test]
fn deposit_credits_available_and_ignores_other_tokens() {
    let mut c = setup();
    assert_eq!(bal(&c, "alice.near"), (100_000_000, 0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        set("fake.near", T0_MS);
        c.ft_on_transfer(acct("alice.near"), U128(1), String::new());
    }));
    assert!(r.is_err(), "deposit from an unsupported token must panic");
    assert_eq!(bal(&c, "alice.near"), (100_000_000, 0));
}

#[test]
fn place_order_locks_required_margin() {
    let mut c = setup();
    set("alice.near", T0_MS + 1);
    let id = c.place_order(true, 300, 100);
    assert_eq!(bal(&c, "alice.near"), (70_000_000, 30_000_000));
    let o = c.get_order(id).unwrap();
    assert_eq!(o.status, "open");
    assert_eq!(o.locked_margin.0, 30_000_000);
    assert_eq!(c.get_open_orders(None, None).len(), 1);
}

#[test]
fn cancel_releases_margin_and_removes_from_open_orders() {
    let mut c = setup();
    set("alice.near", T0_MS + 1);
    let id = c.place_order(true, 300, 100);
    c.cancel_order(id);
    assert_eq!(bal(&c, "alice.near"), (100_000_000, 0));
    assert_eq!(c.get_order(id).unwrap().status, "cancelled");
    assert!(c.get_open_orders(None, None).is_empty());
}

#[test]
#[should_panic(expected = "only the order owner can cancel")]
fn only_owner_cancels() {
    let mut c = setup();
    set("alice.near", T0_MS + 1);
    let id = c.place_order(true, 300, 100);
    set("bob.near", T0_MS + 2);
    c.cancel_order(id);
}

#[test]
#[should_panic(expected = "insufficient available balance")]
fn cannot_order_beyond_balance() {
    let mut c = setup();
    set("alice.near", T0_MS + 1);
    c.place_order(true, 300, 1_000);
}

#[test]
#[should_panic(expected = "tick size")]
fn price_must_respect_tick() {
    let mut c = new_contract();
    c.create_market("SCI-1H".to_string(), T0_MS + HOUR_MS, MULT, 5, 1_000);
    deposit(&mut c, "alice.near", 100_000_000);
    set("alice.near", T0_MS + 1);
    c.place_order(true, 301, 1);
}

#[test]
#[should_panic(expected = "price out of range")]
fn price_above_max_rejected_for_orders() {
    let mut c = setup();
    set("alice.near", T0_MS + 1);
    c.place_order(true, 1_001, 1);
}

#[test]
#[should_panic(expected = "market has expired")]
fn no_orders_after_expiry() {
    let mut c = setup();
    set("alice.near", T0_MS + HOUR_MS);
    c.place_order(true, 300, 1);
}

#[test]
fn match_creates_trade_at_ask_price() {
    let mut c = setup();
    let t = matched(&mut c);
    let trade = c.get_trade(t).unwrap();
    assert_eq!((trade.price, trade.quantity), (290, 100));
    assert_eq!(trade.buyer, acct("alice.near"));
    assert_eq!(trade.buyer_committed.0, 30_000_000);
    assert_eq!(trade.seller_committed.0, 29_000_000);
    assert!(c.get_open_orders(None, None).is_empty());
    // locked stays locked until claim
    assert_eq!(bal(&c, "alice.near"), (70_000_000, 30_000_000));
}

#[test]
#[should_panic(expected = "self trade")]
fn self_trade_rejected() {
    let mut c = setup();
    set("alice.near", T0_MS + 1);
    let bid = c.place_order(true, 300, 10);
    let ask = c.place_order(false, 290, 10);
    c.match_orders(bid, ask);
}

#[test]
#[should_panic(expected = "quantity mismatch")]
fn quantity_must_match() {
    let mut c = setup();
    set("alice.near", T0_MS + 1);
    let bid = c.place_order(true, 300, 10);
    set("bob.near", T0_MS + 2);
    let ask = c.place_order(false, 290, 11);
    c.match_orders(bid, ask);
}

#[test]
#[should_panic(expected = "prices do not cross")]
fn prices_must_cross() {
    let mut c = setup();
    set("alice.near", T0_MS + 1);
    let bid = c.place_order(true, 280, 10);
    set("bob.near", T0_MS + 2);
    let ask = c.place_order(false, 290, 10);
    c.match_orders(bid, ask);
}

#[test]
#[should_panic(expected = "invalid sides")]
fn sides_must_be_bid_then_ask() {
    let mut c = setup();
    set("alice.near", T0_MS + 1);
    let bid = c.place_order(true, 300, 10);
    set("bob.near", T0_MS + 2);
    let ask = c.place_order(false, 290, 10);
    c.match_orders(ask, bid);
}

#[test]
fn full_lifecycle_conserves_funds_and_pays_winner() {
    let mut c = setup();
    let t = matched(&mut c);
    settle_at(&mut c, 310);
    assert_eq!(c.get_market(None).unwrap().settlement_price, Some(310));

    // alice long: +20 * 100 * 10_000 = 20_000_000 -> 30M + 20M
    set("alice.near", T0_MS + HOUR_MS + 20);
    c.claim(t);
    assert_eq!(bal(&c, "alice.near"), (70_000_000 + 50_000_000, 0));
    // bob short: -20_000_000 -> 29M - 20M
    set("bob.near", T0_MS + HOUR_MS + 21);
    c.claim(t);
    assert_eq!(bal(&c, "bob.near"), (71_000_000 + 9_000_000, 0));

    let total = bal(&c, "alice.near").0 + bal(&c, "bob.near").0;
    assert_eq!(total, 200_000_000, "claims must conserve the deposits");
}

#[test]
fn winner_gain_is_capped_by_the_other_sides_margin() {
    let mut c = setup();
    let t = matched(&mut c);
    settle_at(&mut c, 1_000);
    set("alice.near", T0_MS + HOUR_MS + 20);
    c.claim(t);
    set("bob.near", T0_MS + HOUR_MS + 21);
    c.claim(t);
    assert_eq!(bal(&c, "alice.near").0, 70_000_000 + 59_000_000);
    assert_eq!(bal(&c, "bob.near").0, 71_000_000);
    assert_eq!(bal(&c, "alice.near").0 + bal(&c, "bob.near").0, 200_000_000);
}

#[test]
#[should_panic(expected = "already claimed")]
fn double_claim_rejected() {
    let mut c = setup();
    let t = matched(&mut c);
    settle_at(&mut c, 310);
    set("alice.near", T0_MS + HOUR_MS + 20);
    c.claim(t);
    c.claim(t);
}

#[test]
#[should_panic(expected = "not a participant")]
fn only_participants_claim() {
    let mut c = setup();
    let t = matched(&mut c);
    settle_at(&mut c, 310);
    set("mallory.near", T0_MS + HOUR_MS + 20);
    c.claim(t);
}

#[test]
#[should_panic(expected = "market not settled")]
fn cannot_claim_before_settlement() {
    let mut c = setup();
    let t = matched(&mut c);
    set("alice.near", T0_MS + 10);
    c.claim(t);
}

#[test]
#[should_panic(expected = "market has not expired")]
fn cannot_settle_before_expiry() {
    let mut c = setup();
    publish(&mut c, 300, T0_MS + 10);
    set("anyone.near", T0_MS + 11);
    c.settle_market();
}

#[test]
#[should_panic(expected = "oracle price is stale")]
fn cannot_settle_on_stale_oracle() {
    let mut c = setup();
    publish(&mut c, 300, T0_MS + 10);
    // 600_000 ms staleness window, long expired by now
    set("anyone.near", T0_MS + HOUR_MS + 5);
    c.settle_market();
}

#[test]
#[should_panic(expected = "market already settled")]
fn cannot_settle_twice() {
    let mut c = setup();
    settle_at(&mut c, 300);
    set("anyone.near", T0_MS + HOUR_MS + 20);
    c.settle_market();
}

#[test]
#[should_panic(expected = "only the publisher")]
fn only_publisher_updates_price() {
    let mut c = setup();
    set("alice.near", T0_MS);
    c.update_price(300);
}

#[test]
#[should_panic(expected = "price out of range")]
fn publisher_cannot_exceed_max_price() {
    let mut c = setup();
    publish(&mut c, 1_001, T0_MS);
}

#[test]
fn cancel_after_settlement_releases_margin() {
    let mut c = setup();
    set("alice.near", T0_MS + 1);
    let id = c.place_order(true, 300, 100);
    settle_at(&mut c, 300);
    set("alice.near", T0_MS + HOUR_MS + 30);
    c.cancel_order(id);
    assert_eq!(bal(&c, "alice.near"), (100_000_000, 0));
}

#[test]
fn next_market_after_settlement_keeps_old_claims_working() {
    let mut c = setup();
    let t = matched(&mut c);
    settle_at(&mut c, 310);
    set("owner.near", T0_MS + HOUR_MS + 30);
    let next = c.create_market("SCI-1H".to_string(), T0_MS + 2 * HOUR_MS, MULT, 1, 1_000);
    assert_eq!(next, 2);
    assert_eq!(c.get_market(Some(1)).unwrap().settlement_price, Some(310));
    set("alice.near", T0_MS + HOUR_MS + 40);
    c.claim(t);
    assert_eq!(bal(&c, "alice.near").1, 0);
}

#[test]
fn publisher_rolls_the_next_market_with_same_parameters() {
    let mut c = setup();
    settle_at(&mut c, 310);
    set("pub.near", T0_MS + HOUR_MS + 30);
    let next = c.roll_market(T0_MS + 2 * HOUR_MS);
    assert_eq!(next, 2);
    let m = c.get_market(None).unwrap();
    assert_eq!((m.market_id, m.contract_multiplier, m.tick_size, m.margin_ratio_bps), (2, MULT, 1, 1_000));
    assert!(!m.settled);
    assert_eq!(m.expiry_ms, T0_MS + 2 * HOUR_MS);
    assert_eq!(c.get_market(Some(1)).unwrap().settlement_price, Some(310));
}

#[test]
fn raising_max_price_allows_higher_prices_and_orders() {
    let mut c = setup();
    set("owner.near", T0_MS);
    c.set_max_price(10_000);
    assert_eq!(c.get_oracle().max_price, 10_000);
    publish(&mut c, 1_500, T0_MS + 1);
    assert_eq!(c.get_oracle().price, 1_500);
    set("alice.near", T0_MS + 2);
    let id = c.place_order(true, 1_500, 1);
    assert_eq!(c.get_order(id).unwrap().price, 1_500);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_owner_sets_max_price() {
    let mut c = setup();
    set("alice.near", T0_MS);
    c.set_max_price(10_000);
}

#[test]
#[should_panic(expected = "max_price must be positive")]
fn max_price_cannot_be_zero() {
    let mut c = setup();
    set("owner.near", T0_MS);
    c.set_max_price(0);
}

#[test]
#[should_panic(expected = "owner or publisher only")]
fn strangers_cannot_roll_markets() {
    let mut c = setup();
    settle_at(&mut c, 310);
    set("alice.near", T0_MS + HOUR_MS + 30);
    c.roll_market(T0_MS + 2 * HOUR_MS);
}

#[test]
#[should_panic(expected = "current market has not settled")]
fn cannot_roll_before_settlement() {
    let mut c = setup();
    set("pub.near", T0_MS + 5);
    c.roll_market(T0_MS + 2 * HOUR_MS);
}

#[test]
#[should_panic(expected = "current market has not settled")]
fn cannot_create_market_before_current_settles() {
    let mut c = setup();
    set("owner.near", T0_MS + 5);
    c.create_market("SCI-1H".to_string(), T0_MS + 2 * HOUR_MS, MULT, 1, 1_000);
}

#[test]
#[should_panic(expected = "owner only")]
fn admin_methods_are_owner_only() {
    let mut c = setup();
    set("alice.near", T0_MS);
    c.pause();
}

#[test]
#[should_panic(expected = "market is paused")]
fn paused_market_rejects_orders() {
    let mut c = setup();
    set("owner.near", T0_MS);
    c.pause();
    set("alice.near", T0_MS + 1);
    c.place_order(true, 300, 1);
}

#[test]
fn withdraw_debits_and_failed_transfer_refunds() {
    let mut c = setup();
    let mut b = ctx("alice.near", T0_MS + 1);
    b.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
    let _ = c.withdraw(U128(40_000_000));
    assert_eq!(bal(&c, "alice.near"), (60_000_000, 0));

    // failed ft_transfer -> callback restores the balance
    testing_env!(
        ctx("silica.near", T0_MS + 2).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Failed]
    );
    c.on_withdraw(acct("alice.near"), U128(40_000_000));
    assert_eq!(bal(&c, "alice.near"), (100_000_000, 0));
    assert!(get_logs().iter().any(|l| l.contains("withdraw_refunded")));
}

#[test]
fn successful_transfer_keeps_the_debit() {
    let mut c = setup();
    let mut b = ctx("alice.near", T0_MS + 1);
    b.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
    let _ = c.withdraw(U128(40_000_000));

    testing_env!(
        ctx("silica.near", T0_MS + 2).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![])]
    );
    c.on_withdraw(acct("alice.near"), U128(40_000_000));
    assert_eq!(bal(&c, "alice.near"), (60_000_000, 0));
    assert!(get_logs().iter().any(|l| l.contains("\"withdrawn\"")));
}

#[test]
#[should_panic(expected = "insufficient available balance")]
fn cannot_withdraw_locked_funds() {
    let mut c = setup();
    set("alice.near", T0_MS + 1);
    c.place_order(true, 300, 100); // locks 30M
    let mut b = ctx("alice.near", T0_MS + 2);
    b.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
    let _ = c.withdraw(U128(80_000_000)); // only 70M available
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_requires_one_yocto() {
    let mut c = setup();
    set("alice.near", T0_MS + 1);
    let _ = c.withdraw(U128(1));
}

#[test]
fn views_paginate_by_account() {
    let mut c = setup();
    matched(&mut c);
    assert_eq!(c.get_orders_by_account(acct("alice.near"), None, None).len(), 1);
    assert_eq!(c.get_trades_by_account(acct("bob.near"), None, None).len(), 1);
    assert!(c.get_trades_by_account(acct("carol.near"), None, None).is_empty());
    assert!(c.get_orders_by_account(acct("alice.near"), Some(1), Some(10)).is_empty());
}
