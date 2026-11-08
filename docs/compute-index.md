# Congest Compute Index (CCI): methodology v1.0

The CCI is a composite price index of "compute" across five markets. It starts at **1000** on its base date and moves with the weighted geometric mean of how each component's price has changed since then. It is designed to be (1) computed from free, public data anyone can re-run, and (2) the settlement reference for a cash-settled futures market on NEAR.

## Formula

```
level = 1000 × Π (value_i / base_i) ^ w_i
```

- `value_i`: the component's current price (see below).
- `base_i`: the component's price on the base date (`server/src/compute/base.ts`).
- `w_i`: effective weight. Nominal weights below, renormalised to sum to 1 across the components that are currently available.

A geometric mean means a 10% rise in one component moves the index by the same amount whatever the units, and no single component's scale can dominate.

## Components (v1.0)

| Id | What it measures | Unit | Weight | Source |
|---|---|---|---|---|
| `gpu_marketplace` | Rental price of GPUs on an open marketplace (H100 SXM 50%, A100 SXM4 30%, RTX 4090 20%) | $/GPU-hour | 30% | Vast.ai public offers; median per GPU after trimming the top and bottom 10% |
| `cloud_gpu_spot` | Spot price of cloud GPU VMs (A100 and H100, one GPU each) | $/GPU-hour | 20% | Azure Retail Prices API; median across four US regions |
| `ai_inference` | Price of AI model inference (fixed basket of 8 models) | $/1M tokens, blended 3:1 input:output | 20% | OpenRouter model list; geometric mean of the basket |
| `btc_hashprice` | Revenue per unit of Bitcoin mining hashrate | $/TH/day | 20% | Network hashrate (blockchain.info) and BTC/USD (CoinGecko, falling back to blockchain.info) |
| `blockspace` | Ethereum blockspace stress (EGSI, 0-1000) | score | 10% | Congest's own EGSI function, computed from recent Ethereum blocks |

Hashprice is `3.125 BTC × 144 blocks/day × BTC/USD ÷ hashrate(TH/s)`. It uses the block subsidy only, ignores transaction fees, and assumes the difficulty-adjusted 144 blocks per day.

## Quality controls

- **Availability:** each source has an 8-second timeout and one retry. A failing source is marked `down`, its weight is redistributed, and the index is flagged `degraded`.
- **Minimum coverage:** with fewer than three components available the index is not published (`level: null`).
- **Sanity band:** a component more than 10× above or below its base is treated as bad data and excluded.
- **Robust statistics:** medians and trimmed medians for marketplaces; a fixed basket for model prices, so new cheap models cannot drift the index.

## Known limitations (disclose these)

- Sources are public but **unofficial**: Vast.ai's endpoint is the one its own website uses, and any source can change shape, rate-limit, or restrict access.
- Cloud spot uses one vendor (Azure). AWS and GCP prices need credentials.
- The GPU and cloud components are spot prices, not the contract prices large buyers pay.
- Weights and baskets are fixed for v1.0. Changing them is a new methodology version, with the old and new series overlapped for a period, not a silent edit.
- There is no stored history yet. A level can be recomputed at any moment, but past levels cannot be reproduced without a persisted series (planned with the Supabase database).
- Settlement should use an average over a window (e.g. 24 hours) for slow contracts, not a single reading.

## From index to futures

The NEAR contract already trades any price between 0 and `max_price`. For the CCI:

- Contract price = `round(level)` (base 1000). One tick is 0.1% of base.
- Set `max_price` to 10,000 (10× base).
- Use daily or weekly expiries, since compute prices move slowly, and settle on a window average.

## Roadmap

1. Persist the series in Supabase; publish a history chart.
2. Add licensed GPU indices (e.g. from an index provider) as additional components or a cross-check.
3. Add multiple cloud vendors, and storage or egress only if a volatile, observable price exists.
4. Move the settlement price on-chain through several independent publishers.
