# Market notes: SCI-1H

The product is **Silica**; the index is the Silica Compute Index (`SCI`, see `compute-index.md`) and the hourly market is `SCI-1H`.

## Demo liquidity

Orders only match an opposite order of the **same quantity** (the contract rejects a quantity mismatch), and on a testnet demo nobody is on the other side. So the cron tick can run an optional maker (`SILICA_DEMO_LIQUIDITY=true`, `SILICA_DEMO_LIQUIDITY_QUANTITY`, default 100). It quotes one bid and one ask of that quantity, one tick either side of the index, from the **publisher (oracle) account**, re-pricing them as the index moves and stopping in the last 60 seconds before expiry. After a market rolls it cancels the maker's orders in the old market and claims its settled trades (at most 5 per tick) so its margin recycles.

**Conflict of interest.** The maker is the account that sets the oracle price. An oracle operator trading against users is a conflict of interest. This is acceptable only for a testnet demo and must not be enabled anywhere real money is at stake.

**Quantity.** Quantities are in on-chain units, and the app shows 100 units as 1.00 contract. Orders only match an opposite order of the same quantity, so the maker's default of 100 units fills exactly 1-contract orders; other sizes rest until a matching order arrives. The maker's account needs collateral deposited in the contract to cover margin; if it does not, the tick skips the quote and records `liquidity: insufficient balance`.

## Settlement timing

The market settles at the **first tick after expiry**, using the index value at that moment, not a value at the exact expiry time. If ticks are delayed, the settlement price reflects a later index reading. Settlement should use a window average in a production design (see `compute-index.md`, known limitations).