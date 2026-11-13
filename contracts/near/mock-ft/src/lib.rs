//! Testnet-only NEP-141 "tUSDC" (6 decimals) used as Silica collateral. There is
//! no official testnet USDC, so this token has a public, capped faucet.
//! NEVER deploy this to mainnet.

use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue};

/// 1,000 tUSDC per faucet call, at most 10,000 tUSDC held by one account.
const FAUCET_AMOUNT: u128 = 1_000_000_000;
const FAUCET_CAP: u128 = 10_000_000_000;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Token,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    token: FungibleToken,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self { token: FungibleToken::new(StorageKey::Token) }
    }

    /// Mints `FAUCET_AMOUNT` to the caller (registering them if needed).
    pub fn faucet(&mut self) -> U128 {
        let id = env::predecessor_account_id();
        if !self.token.accounts.contains_key(&id) {
            self.token.internal_register_account(&id);
        }
        require!(self.token.ft_balance_of(id.clone()).0 + FAUCET_AMOUNT <= FAUCET_CAP, "faucet cap reached");
        self.token.internal_deposit(&id, FAUCET_AMOUNT);
        U128(FAUCET_AMOUNT)
    }

    /// Mint to any account (registers it). Open on purpose: testnet only.
    pub fn mint_to(&mut self, account_id: AccountId, amount: U128) {
        if !self.token.accounts.contains_key(&account_id) {
            self.token.internal_register_account(&account_id);
        }
        self.token.internal_deposit(&account_id, amount.0);
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount).0.into()
    }
}
// The crate's `impl_fungible_token_storage!` macro does not match its own
// `StorageManagement` trait in this version, so delegate by hand.
#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.storage_unregister(force)
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "GASX test USDC".to_string(),
            symbol: "tUSDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn as_caller(name: &str) {
        let id: AccountId = name.parse().unwrap();
        testing_env!(VMContextBuilder::new().predecessor_account_id(id).build());
    }

    #[test]
    fn faucet_registers_and_mints() {
        as_caller("alice.testnet");
        let mut c = Contract::new();
        assert_eq!(c.faucet().0, FAUCET_AMOUNT);
        assert_eq!(c.ft_balance_of("alice.testnet".parse().unwrap()).0, FAUCET_AMOUNT);
        assert_eq!(c.ft_total_supply().0, FAUCET_AMOUNT);
    }

    #[test]
    fn faucet_fills_up_to_the_cap() {
        as_caller("alice.testnet");
        let mut c = Contract::new();
        for _ in 0..(FAUCET_CAP / FAUCET_AMOUNT) {
            c.faucet();
        }
        assert_eq!(c.ft_balance_of("alice.testnet".parse().unwrap()).0, FAUCET_CAP);
    }

    #[test]
    #[should_panic(expected = "faucet cap reached")]
    fn faucet_stops_at_the_cap() {
        as_caller("alice.testnet");
        let mut c = Contract::new();
        for _ in 0..=(FAUCET_CAP / FAUCET_AMOUNT) {
            c.faucet();
        }
    }

    #[test]
    fn mint_to_registers_the_receiver() {
        as_caller("alice.testnet");
        let mut c = Contract::new();
        c.mint_to("bob.testnet".parse().unwrap(), U128(42));
        assert_eq!(c.ft_balance_of("bob.testnet".parse().unwrap()).0, 42);
    }

    #[test]
    fn metadata_is_six_decimal_tusdc() {
        let m = Contract::new().ft_metadata();
        assert_eq!(m.symbol, "tUSDC");
        assert_eq!(m.decimals, 6);
    }
}
