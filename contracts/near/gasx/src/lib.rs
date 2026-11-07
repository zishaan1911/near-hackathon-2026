//! GASX: EGSI-1H gas futures exchange on NEAR.
//!
//! Port of the Sui Move package (`contracts/gasx`, kept in git history under
//! the `pre-hackathon` tag). The ABI is frozen in `docs/near-abi.md`.
//!
//! Model: one contract account holds every trader's collateral (a single
//! NEP-141 token) in internal `available` / `locked` balances. Traders place
//! limit orders (margin is locked), anyone may match a crossing bid/ask pair,
//! anyone may settle a market after expiry using the oracle's price, and each
//! side then claims its own capped payout. Admin can create and pause markets
//! and rotate the oracle publisher, but cannot settle or touch trader funds.

mod events;
mod risk;
#[cfg(test)]
mod tests;

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseOrValue,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_ON_WITHDRAW: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const DEFAULT_PAGE: u64 = 50;
const MAX_PAGE: u64 = 200;

#[ext_contract(ext_ft)]
pub trait ExtFungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Accounts,
    Markets,
    Orders,
    Trades,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Account {
    pub available: u128,
    pub locked: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Oracle {
    pub price: u64,
    pub has_price: bool,
    pub last_update_ms: u64,
    pub max_staleness_ms: u64,
    pub max_price: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Market {
    pub underlying: String,
    pub expiry_ms: u64,
    pub contract_multiplier: u64,
    pub tick_size: u64,
    pub margin_ratio_bps: u64,
    pub paused: bool,
    pub settled: bool,
    pub settlement_price: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum OrderStatus {
    Open,
    Filled,
    Cancelled,
}

impl OrderStatus {
    fn as_str(&self) -> &'static str {
        match self {
            OrderStatus::Open => "open",
            OrderStatus::Filled => "filled",
            OrderStatus::Cancelled => "cancelled",
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Order {
    pub market_id: u64,
    pub owner: AccountId,
    pub is_bid: bool,
    pub price: u64,
    pub quantity: u64,
    pub locked_margin: u128,
    pub status: OrderStatus,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Trade {
    pub market_id: u64,
    pub buyer: AccountId,
    pub seller: AccountId,
    pub price: u64,
    pub quantity: u64,
    pub buyer_committed: u128,
    pub seller_committed: u128,
    pub buyer_claimed: bool,
    pub seller_claimed: bool,
}

// ---- views --------------------------------------------------------------

#[near(serializers = [json])]
pub struct MarketView {
    pub market_id: u64,
    pub underlying: String,
    pub expiry_ms: u64,
    pub contract_multiplier: u64,
    pub tick_size: u64,
    pub margin_ratio_bps: u64,
    pub paused: bool,
    pub settled: bool,
    pub settlement_price: Option<u64>,
    pub collateral_token: AccountId,
}

#[near(serializers = [json])]
pub struct OracleView {
    pub price: u64,
    pub has_price: bool,
    pub last_update_ms: u64,
    pub max_staleness_ms: u64,
    pub max_price: u64,
    pub publisher: AccountId,
}

#[near(serializers = [json])]
pub struct AccountView {
    pub available: U128,
    pub locked: U128,
}

#[near(serializers = [json])]
pub struct OrderView {
    pub order_id: u64,
    pub market_id: u64,
    pub owner: AccountId,
    pub is_bid: bool,
    pub price: u64,
    pub quantity: u64,
    pub locked_margin: U128,
    pub status: String,
}

#[near(serializers = [json])]
pub struct TradeView {
    pub trade_id: u64,
    pub market_id: u64,
    pub buyer: AccountId,
    pub seller: AccountId,
    pub price: u64,
    pub quantity: u64,
    pub buyer_committed: U128,
    pub seller_committed: U128,
    pub buyer_claimed: bool,
    pub seller_claimed: bool,
}

fn order_view(order_id: u64, o: &Order) -> OrderView {
    OrderView {
        order_id,
        market_id: o.market_id,
        owner: o.owner.clone(),
        is_bid: o.is_bid,
        price: o.price,
        quantity: o.quantity,
        locked_margin: U128(o.locked_margin),
        status: o.status.as_str().to_string(),
    }
}

fn trade_view(trade_id: u64, t: &Trade) -> TradeView {
    TradeView {
        trade_id,
        market_id: t.market_id,
        buyer: t.buyer.clone(),
        seller: t.seller.clone(),
        price: t.price,
        quantity: t.quantity,
        buyer_committed: U128(t.buyer_committed),
        seller_committed: U128(t.seller_committed),
        buyer_claimed: t.buyer_claimed,
        seller_claimed: t.seller_claimed,
    }
}

fn page(from_index: Option<u64>, limit: Option<u64>) -> (usize, usize) {
    let from = from_index.unwrap_or(0) as usize;
    let limit = limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE) as usize;
    (from, limit)
}

// ---- contract -----------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    collateral_token: AccountId,
    publisher: AccountId,
    oracle: Oracle,
    accounts: LookupMap<AccountId, Account>,
    markets: LookupMap<u64, Market>,
    /// 0 means "no market yet"; ids start at 1.
    current_market_id: u64,
    orders: IterableMap<u64, Order>,
    next_order_id: u64,
    trades: IterableMap<u64, Trade>,
    next_trade_id: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner: AccountId,
        collateral_token: AccountId,
        publisher: AccountId,
        max_staleness_ms: u64,
        max_price: u64,
    ) -> Self {
        require!(!env::state_exists(), "already initialized");
        require!(max_price > 0, "max_price must be positive");
        Self {
            owner_id: owner,
            collateral_token,
            publisher,
            oracle: Oracle { price: 0, has_price: false, last_update_ms: 0, max_staleness_ms, max_price },
            accounts: LookupMap::new(StorageKey::Accounts),
            markets: LookupMap::new(StorageKey::Markets),
            current_market_id: 0,
            orders: IterableMap::new(StorageKey::Orders),
            next_order_id: 1,
            trades: IterableMap::new(StorageKey::Trades),
            next_trade_id: 1,
        }
    }

    // ---- admin ----------------------------------------------------------

    /// Create the first market, or the next one once the current has settled.
    pub fn create_market(
        &mut self,
        underlying: String,
        expiry_ms: u64,
        contract_multiplier: u64,
        tick_size: u64,
        margin_ratio_bps: u64,
    ) -> u64 {
        self.assert_owner();
        if self.current_market_id != 0 {
            require!(self.market(self.current_market_id).settled, "current market has not settled");
        }
        require!(expiry_ms > env::block_timestamp_ms(), "expiry must be in the future");
        require!(contract_multiplier > 0 && tick_size > 0, "multiplier and tick size must be positive");
        require!(margin_ratio_bps > 0 && margin_ratio_bps <= 10_000, "margin ratio out of range");
        self.current_market_id += 1;
        let id = self.current_market_id;
        self.markets.insert(
            id,
            Market {
                underlying: underlying.clone(),
                expiry_ms,
                contract_multiplier,
                tick_size,
                margin_ratio_bps,
                paused: false,
                settled: false,
                settlement_price: 0,
            },
        );
        events::emit(
            "market_created",
            json!({ "market_id": id, "underlying": underlying, "expiry_ms": expiry_ms }),
        );
        id
    }

    /// Owner or publisher: start the next market with the *same* parameters as
    /// the current (settled) one, expiring at `expiry_ms`. Lets the oracle
    /// service roll hourly markets without holding the owner key; it cannot
    /// change any market parameter.
    pub fn roll_market(&mut self, expiry_ms: u64) -> u64 {
        let caller = env::predecessor_account_id();
        require!(caller == self.owner_id || caller == self.publisher, "owner or publisher only");
        require!(self.current_market_id != 0, "no market to roll");
        let current = self.market(self.current_market_id);
        require!(current.settled, "current market has not settled");
        require!(expiry_ms > env::block_timestamp_ms(), "expiry must be in the future");
        self.current_market_id += 1;
        let id = self.current_market_id;
        self.markets.insert(
            id,
            Market {
                underlying: current.underlying.clone(),
                expiry_ms,
                contract_multiplier: current.contract_multiplier,
                tick_size: current.tick_size,
                margin_ratio_bps: current.margin_ratio_bps,
                paused: false,
                settled: false,
                settlement_price: 0,
            },
        );
        events::emit(
            "market_created",
            json!({ "market_id": id, "underlying": current.underlying, "expiry_ms": expiry_ms }),
        );
        id
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.set_paused(true);
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.set_paused(false);
    }

    pub fn set_margin_ratio(&mut self, margin_ratio_bps: u64) {
        self.assert_owner();
        require!(margin_ratio_bps > 0 && margin_ratio_bps <= 10_000, "margin ratio out of range");
        let id = self.current_market_id;
        let mut m = self.market(id);
        require!(!m.settled, "market settled");
        m.margin_ratio_bps = margin_ratio_bps;
        self.markets.insert(id, m);
    }

    pub fn set_publisher(&mut self, publisher: AccountId) {
        self.assert_owner();
        self.publisher = publisher;
    }

    pub fn set_max_staleness(&mut self, max_staleness_ms: u64) {
        self.assert_owner();
        self.oracle.max_staleness_ms = max_staleness_ms;
    }

    // ---- oracle ---------------------------------------------------------

    /// Publisher-only. Rejects a price above `max_price` before touching state.
    pub fn update_price(&mut self, price: u64) {
        require!(env::predecessor_account_id() == self.publisher, "only the publisher can update the price");
        require!(price <= self.oracle.max_price, "price out of range");
        self.oracle.price = price;
        self.oracle.has_price = true;
        self.oracle.last_update_ms = env::block_timestamp_ms();
        events::emit("price_updated", json!({ "price": price, "timestamp_ms": self.oracle.last_update_ms }));
    }

    // ---- collateral -----------------------------------------------------

    /// NEP-141 receiver. Only the configured collateral token may call it.
    /// Credits `sender_id`'s available balance; returns 0 unused tokens.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.collateral_token, "unsupported token");
        require!(amount.0 > 0, "amount must be positive");
        let _ = msg;
        let mut acc = self.load(&sender_id);
        acc.available = acc.available.checked_add(amount.0).expect("balance overflow");
        self.accounts.insert(sender_id.clone(), acc);
        events::emit("deposited", json!({ "account_id": sender_id, "amount": amount }));
        PromiseOrValue::Value(U128(0))
    }

    /// Withdraw from the available balance. Requires exactly 1 yoctoNEAR. If the
    /// token transfer fails the balance is restored in `on_withdraw`.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        require!(amount.0 > 0, "amount must be positive");
        let caller = env::predecessor_account_id();
        let mut acc = self.load(&caller);
        require!(acc.available >= amount.0, "insufficient available balance");
        acc.available -= amount.0;
        self.accounts.insert(caller.clone(), acc);
        ext_ft::ext(self.collateral_token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(caller.clone(), amount, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_WITHDRAW)
                    .on_withdraw(caller, amount),
            )
    }

    #[private]
    pub fn on_withdraw(&mut self, account_id: AccountId, amount: U128) {
        match env::promise_result_checked(0, 0) {
            Ok(_) => events::emit("withdrawn", json!({ "account_id": account_id, "amount": amount })),
            Err(_) => {
                let mut acc = self.load(&account_id);
                acc.available += amount.0;
                self.accounts.insert(account_id.clone(), acc);
                events::emit("withdraw_refunded", json!({ "account_id": account_id, "amount": amount }));
            }
        }
    }

    // ---- trading --------------------------------------------------------

    /// Lock the required margin and place a resting limit order.
    pub fn place_order(&mut self, is_bid: bool, price: u64, quantity: u64) -> u64 {
        let market_id = self.current_market_id;
        let market = self.market(market_id);
        self.assert_tradable(&market);
        require!(price > 0 && price <= self.oracle.max_price, "price out of range");
        require!(price % market.tick_size == 0, "price must be a multiple of the tick size");
        require!(quantity > 0, "quantity must be positive");

        let required =
            risk::required_margin(price, quantity, market.contract_multiplier, market.margin_ratio_bps);
        require!(required > 0, "order too small");

        let caller = env::predecessor_account_id();
        let mut acc = self.load(&caller);
        require!(acc.available >= required, "insufficient available balance");
        acc.available -= required;
        acc.locked += required;
        self.accounts.insert(caller.clone(), acc);

        let order_id = self.next_order_id;
        self.next_order_id += 1;
        self.orders.insert(
            order_id,
            Order {
                market_id,
                owner: caller.clone(),
                is_bid,
                price,
                quantity,
                locked_margin: required,
                status: OrderStatus::Open,
            },
        );
        events::emit(
            "order_placed",
            json!({
                "order_id": order_id, "market_id": market_id, "owner": caller,
                "is_bid": is_bid, "price": price, "quantity": quantity, "locked_margin": U128(required),
            }),
        );
        order_id
    }

    /// Owner-only. Releases the locked margin. Allowed after settlement too.
    pub fn cancel_order(&mut self, order_id: u64) {
        let mut order = self.orders.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("order not found"));
        require!(order.owner == env::predecessor_account_id(), "only the order owner can cancel");
        require!(order.status == OrderStatus::Open, "order is not open");
        let mut acc = self.load(&order.owner);
        require!(acc.locked >= order.locked_margin, "locked balance inconsistent");
        acc.locked -= order.locked_margin;
        acc.available += order.locked_margin;
        self.accounts.insert(order.owner.clone(), acc);
        order.status = OrderStatus::Cancelled;
        let owner = order.owner.clone();
        self.orders.insert(order_id, order);
        events::emit("order_cancelled", json!({ "order_id": order_id, "owner": owner }));
    }

    /// Permissionless. Matches one open bid with one open ask of equal quantity
    /// whose prices cross, at the ask's price. All validation happens here.
    pub fn match_orders(&mut self, buy_order_id: u64, sell_order_id: u64) -> u64 {
        require!(buy_order_id != sell_order_id, "same order");
        let market_id = self.current_market_id;
        let market = self.market(market_id);
        self.assert_tradable(&market);

        let mut buy = self.orders.get(&buy_order_id).cloned().unwrap_or_else(|| env::panic_str("buy order not found"));
        let mut sell =
            self.orders.get(&sell_order_id).cloned().unwrap_or_else(|| env::panic_str("sell order not found"));
        require!(buy.market_id == market_id && sell.market_id == market_id, "wrong market");
        require!(buy.status == OrderStatus::Open && sell.status == OrderStatus::Open, "order is not open");
        require!(buy.is_bid && !sell.is_bid, "invalid sides");
        require!(buy.quantity == sell.quantity, "quantity mismatch");
        require!(buy.price >= sell.price, "prices do not cross");
        require!(buy.owner != sell.owner, "self trade");

        let trade_price = sell.price;
        let quantity = buy.quantity;
        let trade_id = self.next_trade_id;
        self.next_trade_id += 1;
        self.trades.insert(
            trade_id,
            Trade {
                market_id,
                buyer: buy.owner.clone(),
                seller: sell.owner.clone(),
                price: trade_price,
                quantity,
                buyer_committed: buy.locked_margin,
                seller_committed: sell.locked_margin,
                buyer_claimed: false,
                seller_claimed: false,
            },
        );
        buy.status = OrderStatus::Filled;
        sell.status = OrderStatus::Filled;
        let (buyer, seller) = (buy.owner.clone(), sell.owner.clone());
        self.orders.insert(buy_order_id, buy);
        self.orders.insert(sell_order_id, sell);
        events::emit(
            "trade_executed",
            json!({
                "trade_id": trade_id, "market_id": market_id, "buy_order_id": buy_order_id,
                "sell_order_id": sell_order_id, "buyer": buyer, "seller": seller,
                "price": trade_price, "quantity": quantity,
            }),
        );
        trade_id
    }

    // ---- settlement -----------------------------------------------------

    /// Permissionless, once per market: after expiry, with a fresh oracle price.
    pub fn settle_market(&mut self) {
        let id = self.current_market_id;
        let mut market = self.market(id);
        require!(!market.settled, "market already settled");
        let now = env::block_timestamp_ms();
        require!(now >= market.expiry_ms, "market has not expired");
        require!(
            self.oracle.has_price && now - self.oracle.last_update_ms <= self.oracle.max_staleness_ms,
            "oracle price is stale"
        );
        market.settled = true;
        market.settlement_price = self.oracle.price;
        let price = market.settlement_price;
        self.markets.insert(id, market);
        events::emit("market_settled", json!({ "market_id": id, "settlement_price": price }));
    }

    /// Pull-based payout for the caller's side of a settled trade.
    pub fn claim(&mut self, trade_id: u64) {
        let mut trade = self.trades.get(&trade_id).cloned().unwrap_or_else(|| env::panic_str("trade not found"));
        let market = self.market(trade.market_id);
        require!(market.settled, "market not settled");

        let caller = env::predecessor_account_id();
        let is_buyer = caller == trade.buyer;
        require!(is_buyer || caller == trade.seller, "not a participant");
        let (committed, other_committed) = if is_buyer {
            require!(!trade.buyer_claimed, "already claimed");
            (trade.buyer_committed, trade.seller_committed)
        } else {
            require!(!trade.seller_claimed, "already claimed");
            (trade.seller_committed, trade.buyer_committed)
        };

        let (pnl, negative) = risk::compute_pnl(
            is_buyer,
            trade.price,
            market.settlement_price,
            trade.quantity,
            market.contract_multiplier,
        );
        let amount = risk::payout(committed, other_committed, pnl, negative);

        let mut acc = self.load(&caller);
        require!(acc.locked >= committed, "locked balance inconsistent");
        acc.locked -= committed;
        acc.available += amount;
        self.accounts.insert(caller.clone(), acc);

        if is_buyer {
            trade.buyer_claimed = true;
        } else {
            trade.seller_claimed = true;
        }
        self.trades.insert(trade_id, trade);
        events::emit(
            "claimed",
            json!({
                "trade_id": trade_id, "account_id": caller, "payout": U128(amount),
                "pnl": U128(pnl), "pnl_is_negative": negative,
            }),
        );
    }

    // ---- views ----------------------------------------------------------

    pub fn get_market(&self, market_id: Option<u64>) -> Option<MarketView> {
        let id = market_id.unwrap_or(self.current_market_id);
        self.markets.get(&id).map(|m| MarketView {
            market_id: id,
            underlying: m.underlying.clone(),
            expiry_ms: m.expiry_ms,
            contract_multiplier: m.contract_multiplier,
            tick_size: m.tick_size,
            margin_ratio_bps: m.margin_ratio_bps,
            paused: m.paused,
            settled: m.settled,
            settlement_price: if m.settled { Some(m.settlement_price) } else { None },
            collateral_token: self.collateral_token.clone(),
        })
    }

    pub fn get_oracle(&self) -> OracleView {
        OracleView {
            price: self.oracle.price,
            has_price: self.oracle.has_price,
            last_update_ms: self.oracle.last_update_ms,
            max_staleness_ms: self.oracle.max_staleness_ms,
            max_price: self.oracle.max_price,
            publisher: self.publisher.clone(),
        }
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        let a = self.load(&account_id);
        AccountView { available: U128(a.available), locked: U128(a.locked) }
    }

    pub fn get_order(&self, order_id: u64) -> Option<OrderView> {
        self.orders.get(&order_id).map(|o| order_view(order_id, o))
    }

    /// Open orders in the current market, ascending id.
    pub fn get_open_orders(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<OrderView> {
        let (from, limit) = page(from_index, limit);
        let market_id = self.current_market_id;
        self.orders
            .iter()
            .filter(|(_, o)| o.market_id == market_id && o.status == OrderStatus::Open)
            .skip(from)
            .take(limit)
            .map(|(id, o)| order_view(*id, o))
            .collect()
    }

    pub fn get_orders_by_account(
        &self,
        account_id: AccountId,
        from_index: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<OrderView> {
        let (from, limit) = page(from_index, limit);
        self.orders
            .iter()
            .filter(|(_, o)| o.owner == account_id)
            .skip(from)
            .take(limit)
            .map(|(id, o)| order_view(*id, o))
            .collect()
    }

    pub fn get_trade(&self, trade_id: u64) -> Option<TradeView> {
        self.trades.get(&trade_id).map(|t| trade_view(trade_id, t))
    }

    pub fn get_trades_by_account(
        &self,
        account_id: AccountId,
        from_index: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<TradeView> {
        let (from, limit) = page(from_index, limit);
        self.trades
            .iter()
            .filter(|(_, t)| t.buyer == account_id || t.seller == account_id)
            .skip(from)
            .take(limit)
            .map(|(id, t)| trade_view(*id, t))
            .collect()
    }
}

// ---- internals ----------------------------------------------------------

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    fn market(&self, id: u64) -> Market {
        self.markets.get(&id).cloned().unwrap_or_else(|| env::panic_str("market not found"))
    }

    fn set_paused(&mut self, paused: bool) {
        let id = self.current_market_id;
        let mut m = self.market(id);
        require!(!m.settled, "market settled");
        m.paused = paused;
        self.markets.insert(id, m);
        events::emit("market_status_changed", json!({ "market_id": id, "paused": paused }));
    }

    /// Open for new orders and matches: not paused, not settled, not expired.
    fn assert_tradable(&self, market: &Market) {
        require!(!market.paused, "market is paused");
        require!(!market.settled, "market already settled");
        require!(env::block_timestamp_ms() < market.expiry_ms, "market has expired");
    }

    fn load(&self, id: &AccountId) -> Account {
        self.accounts.get(id).cloned().unwrap_or_default()
    }
}
