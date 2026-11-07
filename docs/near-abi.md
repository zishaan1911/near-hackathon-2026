# GASX NEAR contract ABI (frozen)

One contract account (`GASX_NEAR_CONTRACT_ID`, e.g. `gasx.testnet`) holds the exchange. One collateral token (`GASX_NEAR_COLLATERAL_TOKEN`, NEP-141 tUSDC, 6 decimals).
Encoding: JSON. `u64` values (price, quantity, ids, timestamps in ms) are JSON **numbers**. Token amounts are `U128` = decimal **strings**. Account ids are strings.
Units: index price is the EGSI score (0-1000). Margin and payouts are in token base units. `notional = price * quantity * contract_multiplier`; `required_margin = notional * margin_ratio_bps / 10000`.

Markets are numbered. The contract has a `current_market_id`. An admin can start the next market after the current one settles. Old markets keep their settlement price so late claims still work.

## Views (call_function, no gas)

| Method | Args | Returns |
|---|---|---|
| `get_market` | `{ market_id?: u64 }` (default current) | `MarketView` |
| `get_oracle` | `{}` | `OracleView` |
| `get_account` | `{ account_id }` | `{ available: U128, locked: U128 }` |
| `get_order` | `{ order_id: u64 }` | `OrderView \| null` |
| `get_open_orders` | `{ from_index?: u64, limit?: u64 }` (current market, open only, ascending id) | `OrderView[]` |
| `get_orders_by_account` | `{ account_id, from_index?: u64, limit?: u64 }` | `OrderView[]` |
| `get_trade` | `{ trade_id: u64 }` | `TradeView \| null` |
| `get_trades_by_account` | `{ account_id, from_index?: u64, limit?: u64 }` | `TradeView[]` |

```
MarketView = { market_id: u64, underlying: string, expiry_ms: u64, contract_multiplier: u64,
               tick_size: u64, margin_ratio_bps: u64, paused: bool, settled: bool,
               settlement_price: u64 | null, collateral_token: string }
OracleView = { price: u64, has_price: bool, last_update_ms: u64, max_staleness_ms: u64,
               max_price: u64, publisher: string }
OrderView  = { order_id: u64, market_id: u64, owner: string, is_bid: bool, price: u64,
               quantity: u64, locked_margin: U128, status: "open" | "filled" | "cancelled" }
TradeView  = { trade_id: u64, market_id: u64, buyer: string, seller: string, price: u64, quantity: u64,
               buyer_committed: U128, seller_committed: U128, buyer_claimed: bool, seller_claimed: bool }
```

## Change methods (signed by the caller)

| Method | Caller | Args | Notes |
|---|---|---|---|
| `new` | deployer (init) | `{ owner, collateral_token, publisher, max_staleness_ms: u64, max_price: u64 }` | once |
| `create_market` | owner | `{ underlying, expiry_ms, contract_multiplier, tick_size, margin_ratio_bps }` | first market, or next one after the current settled; sets current |
| `pause` / `unpause` | owner | `{}` | |
| `set_margin_ratio` | owner | `{ margin_ratio_bps }` | |
| `set_publisher` | owner | `{ publisher }` | |
| `set_max_staleness` | owner | `{ max_staleness_ms }` | |
| `update_price` | publisher | `{ price: u64 }` | rejects `price > max_price` |
| `withdraw` | any | `{ amount: U128 }` | needs **1 yoctoNEAR** attached; pays out from `available` via `ft_transfer`; refunded on failure |
| `place_order` | any | `{ is_bid: bool, price: u64, quantity: u64 }` -> `u64` order id | locks required margin from `available`; price must be a multiple of tick size |
| `cancel_order` | order owner | `{ order_id: u64 }` | releases locked margin; allowed also after settlement |
| `match_orders` | anyone | `{ buy_order_id: u64, sell_order_id: u64 }` -> `u64` trade id | same checks as the Move version; trades at the ask price; does not allow self-trade |
| `settle_market` | anyone | `{}` | after expiry, fresh oracle, once |
| `claim` | buyer or seller | `{ trade_id: u64 }` | credits payout to the caller's `available`; once per side |

Deposit: user calls `ft_transfer_call` on the **token** contract:
`{ receiver_id: <gasx contract>, amount: "<U128>", msg: "" }` with **1 yoctoNEAR** attached. The contract's `ft_on_transfer` credits `available` (only accepts the configured token) and returns `"0"`.
The token contract (and the user) must be registered with storage on each other: the user needs `storage_deposit` on the token, and the gasx contract is registered once at deploy.

Account storage: the contract does not charge storage per account (the owner funds it).

## Events (NEP-297, standard `gasx`, version `1.0.0`)

`order_placed`, `order_cancelled`, `trade_executed`, `market_settled`, `claimed`, `price_updated`, `deposited`, `withdrawn`. Logged as `EVENT_JSON:{...}`. Data fields mirror the view fields (snake_case).

## Gas

`place_order`, `cancel_order`, `match_orders`, `claim`, `update_price`, `settle_market`: 30 Tgas. `withdraw`: 60 Tgas. `ft_transfer_call`: 100 Tgas. Deposits attached: `withdraw` and `ft_transfer_call` = `"1"` yoctoNEAR, everything else `"0"`.

## Wallet-selector transaction shape produced by the adapter

```
PreparedTransaction = {
  receiverId: string,
  actions: [{ type: "FunctionCall", params: { methodName, args, gas: string, deposit: string } }],
  summary: Record<string, string | number | boolean>
}
```
`gas` and `deposit` are strings in base units (gas in gas units, deposit in yoctoNEAR). This is the `Action` format `wallet.signAndSendTransaction({ receiverId, actions })` takes in `@near-wallet-selector/core`.
