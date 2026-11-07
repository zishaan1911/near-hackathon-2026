# GASX → NEAR: Implementation Plan

Track: `defi` (Unstoppable DeFi). Scope: **exchange only**. Deadline: 2026-11-14T23:59Z.
Repo: `github.com/zishaan1911/near-hackathon-2026` (was empty). Commit `57dffb9` imports the GASX baseline (GASX @ 7a61c56, minus `database/backup`), tagged `pre-hackathon`. Work branch: `near-hackathon`. Final tag: `hackathon-submission` (Q-003). Nothing is pushed yet. The README must disclose that the baseline predates the hackathon and was built on Sui (Q-002, Q-005).
The baseline is imported whole, including the Sui and Thetanuts code, so it is honest and the deletions show up in the diff. Paths below are relative to this repo.

## 0. Findings from reading the code

- The Sui coupling is **narrow and clean**. `blockchain/sui` implements a 5-method `ChainAdapter` (`getMarketState`, `prepareOpenAccount/Deposit/PlaceOrder/CancelOrder`). `api/` depends only on that interface (`api/src/server.ts`), so the API, risk policy, AI service, C++ engine and DB are reusable.
- Sui touches the frontend in only 5 files: `App.tsx`, `AppHeader.tsx`, `TradePage.tsx`, `WalletModal.tsx`, `main.tsx` (dapp-kit).
- Contract is 1,236 lines of Move across 9 modules; core logic is small: margin lock/release, bid/ask match at ask price, pull-based claim, capped payout, permissionless settle after expiry.
- **Gap found:** there is no oracle publisher service in the repo. Only `scripts/deploy-sui.sh` mentions the publisher. Nothing pushes EGSI on-chain, so the market can never settle live. This must be built.
- **Orders are matched by anyone:** the Move `match_orders` is permissionless and requires an off-chain matcher. No matcher service exists in the repo either (the C++ engine gives depth/quotes only). Must be built, or matching must be triggered from the API.
- Thetanuts: `blockchain/thetanuts`, `api/src/routes/hedge.ts` (492 lines), `exposure.ts`, `HedgePage.tsx` (637 lines). Not needed for an exchange → **delete**.

## 1. Design decisions

| Topic | Decision | Why |
|---|---|---|
| Contract language | Rust, `near-sdk` | Standard on NEAR, `near-workspaces` sandbox tests |
| State model | One contract, `LookupMap`s for accounts/orders/trades. No per-user objects | NEAR has no shared-object/ownership constraint; `match_orders` can mutate both accounts atomically. Removes the Move "pull claim" workaround |
| Collateral | NEP-141 USDC; deposit via `ft_transfer_call` → `ft_on_transfer`; withdraw via `ft_transfer` (1 yocto) with rollback callback | Standard pattern. Rollback on failed transfer is the main bug risk |
| Math | Keep Move formulas **exactly** (`notional`, `required_margin`, `compute_pnl`, capped payout). Use `i128` for PnL | C++ `move_parity_tests` stay valid |
| Oracle | Keep: single publisher account, `max_price` (1000), `max_staleness_ms`, admin rotates publisher | Port as-is |
| Settlement price (P1) | Average of the last N on-chain updates before expiry, instead of the last tick | Cheap manipulation resistance; addresses the "we control the feed" weakness |
| Testnet token | Deploy a mock NEP-141 "tUSDC" | No testnet USDC; testnet-only is eligible (Q-010) |
| NEAR Intents (P1) | Cross-chain deposit: 1Click quote (`dry: true` while testing) → USDC lands on user's NEAR account → `ft_transfer_call` to GASX | Track hint; strengthens the DeFi story. Not required for core |
| Cut | Thetanuts hedge, agent function-call keys, TEE oracle, Sui | Per scope decision |
| Kept unchanged | AI forecast, Kora chat, C++ engine, MySQL, nginx, Docker | Baseline; listed in README |

## 2. Contract ABI (frozen first so agents can work in parallel)

All amounts `U128` serialized as decimal strings; prices/quantities `u64`.

```
// admin (owner only)
new(owner, collateral_token, publisher, max_staleness_ms, max_price)
create_market(underlying: String, expiry_ms: u64, contract_multiplier: u64, tick_size: u64, margin_ratio_bps: u64)
pause() / unpause() / set_margin_ratio(bps) / set_publisher(id) / set_max_staleness(ms)

// oracle
update_price(price: u64)                       // publisher only
get_oracle() -> { price, has_price, last_update_ms, max_staleness_ms, max_price }

// collateral
ft_on_transfer(sender_id, amount, msg) -> U128 // only from collateral_token; credits available
withdraw(amount: U128) -> Promise              // available only; rollback on ft_transfer failure
get_account(account_id) -> { available, locked }

// trading
place_order(is_bid: bool, price: u64, quantity: u64) -> u64 (order_id)   // locks required margin
cancel_order(order_id: u64)
match_orders(buy_id: u64, sell_id: u64) -> u64 (trade_id)                // permissionless; same checks as Move
get_order(id) / get_open_orders(from, limit)

// settlement
settle_market()                                // permissionless, once, after expiry, fresh oracle
claim(trade_id: u64)                           // buyer or seller; capped payout; double-claim guard
get_market() -> { underlying, expiry_ms, multiplier, tick, margin_bps, paused, settled, settlement_price, oracle }
get_trade(id)
```

Events: NEP-297 (`order_placed`, `order_cancelled`, `trade_executed`, `market_settled`, `claimed`, `price_updated`) for the indexer/UI.

## 3. File changes

### Contract (me)
- `[NEW]` `contracts/near/gasx/Cargo.toml`, `src/lib.rs`, `src/{market,oracle,margin,order,settlement,risk,events}.rs`
- `[NEW]` `contracts/near/gasx/tests/sandbox.rs` (near-workspaces: deposit → place → match → settle → claim → withdraw; stale oracle; double claim; failed-withdraw rollback; non-publisher update)
- `[NEW]` `contracts/near/mock-ft/` (tUSDC NEP-141 for testnet)
- `[DELETE]` `contracts/gasx/` (Move) once the Rust tests are at parity. Kept in git history under `pre-hackathon`.
- Move `implementation_plan.md` to `docs/` before the repo goes public, or delete it.

### Adapter + API (agent B, reviewed by me)
- `[NEW]` `blockchain/near/{package.json,tsconfig*.json,src/{config,client,nearAdapter,marketState,actionBuilders,types,index}.ts,tests/*}`. Same `ChainAdapter` shape. `PreparedTransaction` becomes `{ receiverId, actions[{methodName,args,gas,deposit}], summary }` for wallet-selector; `prepareOpenAccount` removed (no account objects on NEAR).
- `[MODIFY]` `api/src/{server,index,config}.ts`, `api/src/routes/{market,orders,account}.ts`: swap `@gasx/sui-adapter` → `@gasx/near-adapter`, drop hedge deps, rename `DevMarketUnavailableError` handling.
- `[DELETE]` `api/src/routes/hedge.ts`, `api/src/exposure.ts`, `api/tests/{hedgeFlow,exposure}.test.ts`, `blockchain/thetanuts/`
- `[MODIFY]` `api/tests/*`: fakes updated to the new adapter types.
- `[DELETE]` `blockchain/sui/` after cutover.

### Services (agent C)
- `[NEW]` `blockchain/near/src/publisher.ts`: reads EGSI from the AI service every 60 s and calls `update_price`. Key from env only.
- `[NEW]` `blockchain/near/src/matcher.ts`: polls open orders, finds crossing equal-quantity pairs, calls `match_orders`. The contract re-validates everything.
- `[NEW]` `scripts/deploy-near.sh` (replaces `deploy-sui.sh`), `docker-compose.yml` gets `publisher` and `matcher` services.
- `[MODIFY]` `.env.example` files.

### Frontend (agent A)
- `[MODIFY]` `main.tsx`, `App.tsx`, `AppHeader.tsx`, `WalletModal.tsx`, `TradePage.tsx`: dapp-kit → `@near-wallet-selector/core` + `modal-ui` (MyNearWallet, Meteor, HERE). Sign with `signAndSendTransaction`. Add deposit/withdraw panel.
- `[DELETE]` `HedgePage.tsx`; `[MODIFY]` `lib/api.ts` (remove hedge calls, rename types).
- `[MODIFY]` copy: "Sui" → "NEAR".

### P1 (only after core demo works)
- `[NEW]` `frontend/src/components/CrossChainDeposit.tsx` + `api/src/routes/intents.ts`: 1Click quote → deposit address → status polling.
- `[MODIFY]` `oracle.rs`: windowed settlement price.

### Docs (agent D, last)
- `[MODIFY]` `README.md`: what/why, "try it" steps, NEAR integration, baseline vs hackathon diff link (`pre-hackathon...hackathon-submission`), libraries list, disclosure that the Sui version predates the hackathon (Q-002).
- `[NEW]` `docs/demo-post.md` (draft only; you post it).

## 4. Execution with parallel agents

Order:
1. **Me:** freeze the ABI above, scaffold the contract, write work briefs for the adapter, services and frontend.
2. **Launch A, B, C in parallel** (file-disjoint: `frontend/`, `blockchain/near + api/`, `blockchain/near/src/{publisher,matcher}.ts + scripts + compose`). Note B and C both write under `blockchain/near/`, so C is restricted to the two named files and `scripts/`.
3. **Me** meanwhile write and test the contract (security-sensitive, not delegated).
4. Review every diff, run `cargo test`, `npm test` per package, `docker compose up`, then commit in small commits.
5. Testnet deploy, then an end-to-end rehearsal with two accounts.
6. P1 items, README, demo.

## 5. Schedule (UTC)

| Day | Goal |
|---|---|
| Nov 7-8 | ABI frozen, contract + sandbox tests, agents launched |
| Nov 9-10 | Adapter, API cutover, wallet flow, publisher, matcher |
| Nov 11 | Testnet deploy, full trade loop live, delete Sui and Thetanuts code |
| Nov 12 | P1: Intents deposit / windowed settlement price (cut if behind) |
| Nov 13 | README, demo recording, repo public, X post by you |
| Nov 14 | Buffer. Confirm payload, submit once (before 23:59Z) |

## 6. Verification gates

- `cargo test` + sandbox suite green; `cargo near build` succeeds.
- `npm run build && npm test` in `api`, `blockchain/near`, `frontend`.
- C++ `move_parity_tests` unchanged and green.
- Manual: two testnet accounts, deposit → opposing orders → match → advance past expiry → publisher pushes price → settle → both claim → withdraw. Balances sum to deposits.
- `grep` for "sui"/"thetanuts" across the repo returns only the README disclosure.

## 7. Risks

- **Withdraw/claim rollback bugs** (fund loss): sandbox tests are mandatory; contract stays with me.
- **Liquidity:** a 2-sided book with no users makes a dead demo. Mitigation: seed market-maker script (`scripts/seed-liquidity.ts`) posting quotes around EGSI. Add to Nov 11.
- **Centralised oracle:** acknowledged in the README; windowed price mitigates.
- **Intents:** mainnet only, tiny amounts, `dry: true` during dev (Q-007). Optional.
- **Mainnet deploy / any real funds / push / making the repo public / X post / submission:** all need your explicit confirmation at the time.

## 8. Open questions for you

1. Demo network: **testnet with mock tUSDC** (recommended, free, eligible) or mainnet with real USDC?
2. Local location: the clone is in a temporary session folder. Choose a permanent folder before the session ends.
3. Keep Kora chat and AI forecast in the demo? (Assumed yes; no changes needed.)
