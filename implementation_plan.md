# Plan: make the Compute Index tradable, retire Ethereum gas futures

Deadline: 2026-11-14T23:59Z. The earlier NEAR-port plan is in git history (`git log -- implementation_plan.md`).

## Goal
Congest becomes one product: **futures on the Congest Compute Index (CCI), settled on NEAR**. EGSI gas futures, the gas forecast and the gauge go away. Ethereum stays only as the 5% blockspace pillar inside the index.

## Findings
- The contract is generic, so **no second contract and no extra NEAR is needed**. `gasx.testnet` has about 0.77 NEAR free, enough for a code upgrade.
- **Blocker:** `max_price` is 1000 with no setter, and the CCI sits around 1000. The contract needs a small `set_max_price`.
- Market 2 (`EGSI-1H`) expired on Nov 7, unsettled, with zero open orders and zero trades, so closing it affects nobody.
- Nothing publishes prices today: the oracle key and cron secret are not on Vercel. Vercel's free plan allows only one cron a day.
- `frontend` has about 150 EGSI/forecast references across 10 files; `server` about 80 across 6.

## Decisions
| Topic | Choice | Why |
|---|---|---|
| Contract price | `round(CCI level)`, tick 1 = 0.1% of base | Direct, readable |
| `max_price` | 10,000 | 10x headroom |
| Expiry | **Hourly (`CCI-1H`)** | A judge can watch a full trade settle. Compute moves slowly, so a production version should be daily; period is one constant |
| Size | Multiplier 10,000, margin 10% | 1.00 contract = about 1,000 tUSDC notional, 100 margin; 1 index point = 1 tUSDC |
| Keeping the market running | Public, rate-limited `POST /api/v1/market/poke` called by the site, plus a daily Vercel cron backstop | Works on the free plan with no Supabase dependency. Supabase `pg_cron` stays optional |
| Quotes | Symmetric spread around the live CCI | Replaces the gas-forecast quote |

## Files
### Contract (orchestrator; holds funds)
- `[MODIFY]` `contracts/near/gasx/src/lib.rs`: owner-only `set_max_price`.
- `[MODIFY]` `contracts/near/gasx/src/tests.rs`: owner-only, and prices above the old cap accepted after raising it.

### Backend (agent)
- `[MODIFY]` `blockchain/near/src/tick.ts` + `tests/tick.test.ts`: replace `aiUrl` with injected `getPrice()`; publish at most every 60 s.
- `[MODIFY]` `server/src/tick-route.ts`, `server/src/app.ts`, `server/src/config.ts`, `server/src/server.ts`: tick gets its price from the compute service; add `/api/v1/market/poke` (no auth, 15 s rate limit, no-op without an oracle key).
- `[MODIFY]` `server/src/routes/market.ts`: return `{ market, index, orderbook, quote }`; candles from `compute_index_snapshots`.
- `[MODIFY]` `server/src/engineLayer.ts`: quote from the CCI level.
- `[MODIFY]` `server/src/routes/chat.ts`: Kora explains the CCI.
- `[DELETE]` `server/src/aiClient.ts`, `api/ai.py`, root `requirements.txt`, `ai/`; the `python` CI job.
- `[MODIFY]` `vercel.json`: drop the Python function, add the daily cron.
- `[NEW]` `scripts/setup-vercel-secrets.ps1`: you run it; reads the oracle key from your local credentials file, generates `CRON_SECRET`, adds both to Vercel, prints neither.
- `[MODIFY]` server tests and fakes.

### Frontend (agent)
- `[MODIFY]` `App.tsx`, `lib/api.ts`, `components/{MarketDashboard,TradePage,AnalyticsPage,LandingPage,ChatWidget,Charts}.tsx`: trade the CCI; show level, pillars and expiry countdown in place of the gauge and forecast. Poke after each signed order and while the page is open.
- `[MODIFY]` `src/compute/Method.tsx`: enable "Trade CCI".
- `[DELETE]` `components/EgsiGauge.tsx`, `lib/egsi.ts` and its test.

### On-chain, in this order (testnet gas only, well under 0.1 NEAR)
1. Upgrade `gasx.testnet` code (state is preserved).
2. `update_price` then `settle_market` to close empty market 2.
3. `set_max_price(10000)`.
4. `create_market` `CCI-1H` at the next hour.

## Verification
- `cargo test`, full `server` and `blockchain/near` suites, frontend typecheck, build and tests.
- Live rehearsal on testnet: `alice` vs `oracle` deposit, order, match, settle, claim; balances must sum to deposits.
- Open the live site and confirm no EGSI wording remains on the trading screens.

## Risks to disclose
- **Settlement timing:** without a per-minute scheduler, settlement happens at the first tick after expiry, using the index at that moment. A trader could pick that moment. Supabase `pg_cron` narrows this; a production version must settle on a window average.
- **Single publisher:** one oracle account still sets the price.
- **Oracle gas:** ticks spend testnet NEAR from `oracle.gasx.testnet` (about 1 NEAR, roughly 3,000 transactions).
- **Disk:** C: has 520 MB free. `cargo test` needs more. `npm cache clean --force` would free about 2.7 GB (a regenerable cache).

## Needed from you
1. Approve this plan.
2. OK to run `npm cache clean --force`.
3. After the build, run the one secrets script so the oracle can sign.
