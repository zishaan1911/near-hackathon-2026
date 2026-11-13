# Silica Compute Index (SCI): methodology v2.0

The SCI is a composite price index of "compute" across six markets. It starts at **1000** on its base date (2026-11-11) and moves with the weighted geometric mean of how each component's price has changed since then. It is built from free, public data anyone can re-run, and is designed as the settlement reference for a cash-settled futures market on NEAR.

Code: `server/src/compute/`. Endpoints: `GET /api/v1/indices/compute`, `GET /api/v1/indices/compute/history`.

## Formula

```
level = 1000 x PROD_c ( relative_c ^ w_c )
```

- `relative_c` is the component's relative (below), built from its quotes.
- `w_c` is the effective weight: nominal weights renormalised to sum to 1 over the components that are currently OK.
- The level is `null` (not published) when fewer than **4 of the 6** components are OK. The index is flagged `degraded` when any component is down.

A geometric mean means a 10% move in one component moves the index by the same amount whatever its units.

## Matched-quote method

A **quote** is one price from one venue for one product, with a stable key (for example `gpu/h100/vast`, `cloud_gpu/h100/aws-p5.48xlarge`, `ai/openai/gpt-4o-mini`). Each quote has a **base price** fixed on the base date (`BASE_QUOTES` in `server/src/compute/base.ts`).

1. `quote relative = price / base price of the same quote`.
2. A quote whose relative is outside **[0.2, 5]** is discarded as bad data and reported (`detail.discarded`). A quote with no base price is also discarded.
3. Relatives are grouped by weighted geometric mean: quote -> product -> component.
4. Components are combined into the headline by the formula above.

Why: a plain average of prices moves when a cheap venue (say RunPod at $1.79) drops out and an expensive one (Vast at $0.92 for the same tier on a different grade) remains, even though no price changed. Because every quote is only ever compared with its own base, a venue dropping out removes a relative from a geometric mean; if the remaining venues are flat, the level cannot move. The remaining risk is only that surviving venues differ in trend from the missing one, which is real information rather than an artefact.

## Components

| Id | Label | Unit | Weight |
|---|---|---|---|
| `gpu_rental` | GPU rental | $/GPU-hour | 0.35 |
| `cloud_gpu_spot` | Cloud GPU spot | $/GPU-hour | 0.20 |
| `cloud_cpu_spot` | Cloud CPU spot | $/vCPU-hour | 0.10 |
| `ai_inference` | AI inference | $/1M tokens (blended 3:1 input:output) | 0.20 |
| `btc_hashprice` | Bitcoin hashprice | $/TH/day | 0.10 |
| `blockspace` | Ethereum blockspace | $/1M gas (7-day median) | 0.05 |

`value` and `baseValue` in the API are display prices (median of the component's quotes); the level comes from the relatives. `level` per component is `1000 x relative`.

## Sources

- **gpu_rental**: products H100 (0.5), A100 (0.3), RTX 4090 (0.2); one quote per product per venue, venues equally weighted when present.
  - Vast.ai: `POST console.vast.ai/api/v0/bundles/`, trimmed median (10% each side) of `dph_total / num_gpus`, at least 5 offers (H100 SXM, A100 SXM4, RTX 4090).
  - RunPod: GraphQL `gpuTypes` at `api.runpod.io/graphql`; `securePrice` if > 0, else `communityPrice` (H100 80GB HBM3, A100-SXM4-80GB, GeForce RTX 4090).
  - Akash: `console-api.akash.network/v1/gpu-prices`; NVIDIA models with `available > 0`, `price.weightedAverage`, median across RAM variants.
- **cloud_gpu_spot**: Azure Retail Prices API (`Standard_NC24ads_A100_v4`, `Standard_NC40ads_H100_v5`; median across four US regions) and AWS `spot.js` (`g5.xlarge`, `g6.xlarge`, `p4d.24xlarge`, `p5.48xlarge`; per-GPU price, median across `us-east-1`, `us-east-2`, `us-west-1`, `us-west-2`). One quote per vendor SKU; products are `a100`, `h100`, `a10g`, `l4`, equally weighted.
- **cloud_cpu_spot**: AWS spot `m7i`, `c7i`, `r7i`, `m7g` `.xlarge` and Azure `Standard_D4s_v5` (4 vCPU each), $/vCPU-hour, median across US regions. Products: general x86 (m7i + D4s_v5), compute x86, memory x86, general ARM.
- **ai_inference**: fixed basket of 8 OpenRouter models, blended 3:1; one quote per model. At least 4 models must be present.
- **btc_hashprice**: `3.125 BTC x 144 blocks/day x BTC/USD / hashrate(TH/s)`; hashrate from `api.blockchain.info/stats`, BTC/USD from CoinGecko falling back to blockchain.info. Subsidy only, ignores fees, assumes 144 blocks per day.
- **blockspace**: computed in TypeScript from Ethereum JSON-RPC (`SILICA_ETH_RPC_URL`, default `https://ethereum-rpc.publicnode.com`). `baseFeePerGas` is sampled every 300 blocks (about hourly) for 168 samples (7 days) using `eth_getBlockByNumber` in batches of 50. Value = median gwei x 1e-3 x ETH/USD = $/1M gas. ETH/USD comes from CoinGecko, falling back to the Chainlink ETH/USD feed (`eth_call latestAnswer`, 8 decimals). The 7-day median is cached for 1 hour.

## Quality controls

- **Availability:** each source has a timeout (8 s; 30 s for the 7 MB AWS file) and one retry on network error. A failed venue leaves its quotes out; a component with no quotes is `down`, its weight is redistributed and the index is `degraded`.
- **Minimum coverage:** fewer than 4 of 6 OK components -> `level: null`.
- **Sanity band:** quote relatives outside [0.2, 5] are discarded.
- **Robust statistics:** trimmed medians and medians for marketplaces and regions; fixed baskets for models.
- **Caching:** the service caches for 60 s; responses carry `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` (history: `s-maxage=900`) so the CDN absorbs polling and protects upstream sources.

## History and persistence

- `compute_index_snapshots` (migration `0003_compute_index.sql`) stores a row per snapshot: level, components (jsonb), methodology version.
- `GET|POST /api/v1/cron/compute-snapshot` computes and records a snapshot. It needs `Authorization: Bearer <CRON_SECRET>` (503 if unset, 401 if wrong). `0004_compute_cron.sql` schedules it every 15 minutes with `pg_cron` (placeholder setting `app.settings.compute_snapshot_url`).
- `GET /api/v1/indices/compute/history?days=30` (1..90) returns `persisted`, `points` (levels from the database, `[]` when no database is configured), `backfill`, `backcast` and `settlements`.

There are three history series. No database is needed for the first two, and none of them is invented.

1. **Back-cast (daily, up to 90 days before the base date).** Only two pillars have real public history: Bitcoin hashprice (blockchain.info `hash-rate` and `market-price` charts) and Ethereum blockspace (base fee sampled every 6 hours, 7-day rolling median in gwei, times that day's real ETH/USD from CoinGecko `market_chart`; if CoinGecko fails, today's ETH price is used and the response says `ethPrice: "current"` instead of `"daily"`). The level is `1000 * (hash_d / hash_base)^0.10 * (gas_d / gas_base)^0.05`, where each base is the same-method value on the base date, so the back-cast is exactly 1000 on the base date and joins the live index. The other four pillars (GPU rental, cloud GPU, cloud CPU, AI inference) have no public history and are held at their base value. **So the back-cast shows only how the two pillars with public history would have moved the index; it is not the full index.** A day missing either input is skipped, never interpolated. The response field is `backcast: { points: [{ t, level }], method, pillars: ["btc_hashprice", "blockspace"], ethPrice }`, cached for one hour.
2. **On-chain settlements (hourly, real).** Every settled hourly market (underlying ending in `CI-1H`, e.g. `SCI-1H`) stores its settlement price on chain. The API reads `get_market({ market_id })` for every id from 1 to the current one and returns `settlements: [{ t, level, marketId }]`, with `t` the expiry time. Settled markets never change, so they are cached in memory for good; ids not yet settled are re-read at most once a minute. The cache is per server instance and is rebuilt after a restart.
3. **Persisted snapshots.** When a database exists, the cron snapshots above are returned as `points`. There is no public history for GPU, cloud or AI prices, so their own history exists only from the first persisted snapshot.

`backfill` is the per-pillar raw series: hashprice by day and blockspace ($/1M gas) every 6 hours, now priced at each date's real ETH/USD (the earlier constant-ETH approximation is gone).

`GET /api/v1/candles?interval&limit` uses the database when there is one. Without a database it no longer returns 503: it builds candles from the combined real series, with one daily candle per back-cast point (open = previous close) followed by on-chain settlements bucketed by `interval`, and adds `source: "backcast+settlements"`.

## Base values

`npx tsx scripts/snapshotCompute.ts --write-base` fetches live quotes and rewrites `server/src/compute/base.ts` (base date, base quotes, representative component values). `npx tsx scripts/snapshotCompute.ts` prints the live level and per-component quote counts. A quote that was absent when the base was written (for example RTX 4090 on Akash with no availability) has no base and is excluded until a new methodology version re-bases it.

## Why blockspace is a price, not a stress score

v1.0 used a bounded stress score (0-1000) as the blockspace component. It swung with short-lived block utilisation rather than the price of gas, so it was not a price. v2.0 uses the actual price of blockspace: the 7-day median base fee in dollars per million gas, which is smooth, observable by anyone with an RPC endpoint, and comparable in kind to the other components. Its weight was cut from 10% to 5%.

## Known limitations (disclose these)

- Sources are public but **unofficial**: the Vast.ai and RunPod endpoints back their own websites, AWS `spot.js` backs the spot pricing page, and any source can change shape, rate-limit or restrict access.
- GPU and cloud components are **spot or marketplace prices, not contract prices** that large buyers pay.
- **No history for GPU, cloud or AI components** until snapshots accumulate in the database. The back-cast holds them at base, so it understates real moves in the other 85% of the index weight.
- **Single publisher:** one server computes and records the index; there is no on-chain multi-publisher aggregation yet.
- Quotes missing at the base date have no base price (see above).
- Baskets, weights and base quotes are fixed for v2.0. Changing them is a new methodology version, with the old and new series overlapped, not a silent edit.
- Settlement should use an average over a window (for example 24 hours), not a single reading.

## From index to futures

The NEAR contract already trades any price between 0 and `max_price`. For the SCI (market `SCI-1H`):

- Contract price = `round(level)` (base 1000). One tick is 0.1% of base.
- Set `max_price` to 10,000 (10x base).
- Use daily or weekly expiries, since compute prices move slowly, and settle on a window average.

## Roadmap

1. Publish a history chart from the persisted series.
2. Add licensed GPU indices as additional components or a cross-check.
3. More venues (GCP, other marketplaces) and on-chain settlement through several independent publishers.
