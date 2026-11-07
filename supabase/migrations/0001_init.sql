-- GASX schema, Postgres (Supabase).
--
-- Scope follows ARCHITECTURE.md §2: the API gateway is the only client
-- ("Storage | Durable state; live EGSI/orderbook cached in API memory"),
-- and the gateway also owns "indexing", so indexed chain events live
-- here too.
--
-- Not every table below is populated yet. The ones fed by an existing
-- data source are marked LIVE; the ones waiting on the unbuilt indexer
-- are marked PENDING. They are created together so the schema is one
-- coherent artifact, but do not mistake a PENDING table's existence for
-- it having data.
--
-- Conventions:
--   * Chain/protocol timestamps are stored as bigint, exactly as the
--     source reports them (seconds or milliseconds, noted per column) —
--     not converted to timestamptz, because converting loses the source's
--     own notion of time.
--   * `recorded_at` is this database's own wall-clock insert time, kept
--     separate from those protocol timestamps for the same reason.
--   * Money-ish and ratio values use numeric, never float — binary
--     floats silently lose cents.
--   * Row level security is enabled on every table with no policies. Only
--     the gateway connects, with a role that bypasses RLS (the Supabase
--     service/DB role), so anon/authenticated API keys see nothing.
--   * Idempotent: safe to re-run.

create table if not exists egsi_snapshot (
  -- LIVE: written by the gateway every time it reads a new EGSI value
  -- from the AI service. This is the durable history that
  -- ai/inference/train.py needs in order to train on real data.
  id              bigint generated always as identity primary key,
  market          varchar(32) not null,
  score           smallint    not null,
  block_number    bigint      not null,
  -- Source timestamp from the Ethereum block, unix SECONDS.
  block_timestamp bigint      not null,

  -- The six chain-derived components, each normalized 0..1.
  base_fee         numeric(6,5) not null,
  utilization      numeric(6,5) not null,
  mempool_pressure numeric(6,5) not null,
  fee_momentum     numeric(6,5) not null,
  gas_volatility   numeric(6,5) not null,
  dex_activity     numeric(6,5) not null,
  -- NULL when no live Thetanuts signal was available for that cycle.
  -- Distinct from 0.0, which means "signal present, read as calm".
  thetanuts_iv     numeric(6,5) null,
  -- Not part of EGSI's own formula but a forecast feature. Signed.
  thetanuts_skew   numeric(7,5) null,

  recorded_at     timestamptz not null default now(),

  -- The gateway re-reads the same block repeatedly between AI cycles;
  -- this makes those writes idempotent.
  constraint uq_egsi_market_block unique (market, block_number)
);
create index if not exists idx_egsi_recorded on egsi_snapshot (market, recorded_at);
alter table egsi_snapshot enable row level security;

create table if not exists forecast (
  -- LIVE: written alongside each snapshot when the AI service returns a
  -- forecast. Its own table because a forecast can be absent while the
  -- snapshot is still perfectly good.
  id             bigint generated always as identity primary key,
  market         varchar(32)  not null,
  expected_egsi  numeric(7,2) not null,
  confidence     numeric(5,4) not null,
  p_tail_500     numeric(5,4) not null,
  model_version  varchar(64)  not null,
  -- ON DELETE SET NULL: pruning old snapshots should not silently
  -- delete the forecast record that referenced them.
  egsi_snapshot_id bigint null
    references egsi_snapshot (id) on delete set null,
  recorded_at    timestamptz not null default now()
);
create index if not exists idx_forecast_recorded on forecast (market, recorded_at);
alter table forecast enable row level security;

create table if not exists hedge_evaluation (
  -- LIVE: written by POST /api/v1/hedge/evaluate. The audit trail for
  -- ARCHITECTURE.md §8 — every evaluation is recorded, including the
  -- rejected ones and especially why.
  id                bigint generated always as identity primary key,

  -- Inputs.
  net_contracts     integer       not null,
  egsi_level        smallint      not null,
  egsi_notional     numeric(20,2) not null,
  eth_beta_notional numeric(20,2) not null,
  breached          boolean       not null,
  suggested_option_type text null check (suggested_option_type in ('CALL','PUT')),

  -- The confidence reading the decision was made against, if available.
  model_confidence  numeric(5,4) null,

  -- RFQ + best offer, when the evaluation got that far.
  quotation_id      varchar(80)   null,
  rfq_tx_hash       varchar(80)   null,
  offeror           varchar(80)   null,
  price_per_contract numeric(20,6) null,
  quoted_notional   numeric(20,6) null,

  -- `approved` NULL means the evaluation stopped before a final
  -- approve/reject decision was reachable — distinct from false.
  approved          boolean       null,
  reason            varchar(500)  null,
  -- Always false in this build: the gateway stops at the approval step.
  executed          boolean       not null default false,

  recorded_at       timestamptz   not null default now()
);
create index if not exists idx_hedge_recorded on hedge_evaluation (recorded_at);
create index if not exists idx_hedge_quotation on hedge_evaluation (quotation_id);
alter table hedge_evaluation enable row level security;

create table if not exists prepared_order (
  -- LIVE (partially): written by POST /api/v1/orders/prepare. `outcome`
  -- starts as 'prepared'/'rejected' and only reaches 'executed' once an
  -- indexer can confirm it.
  id              bigint generated always as identity primary key,
  trader          varchar(80)  not null,
  margin_account  varchar(80)  not null,
  is_bid          boolean      not null,
  price           bigint       not null,
  quantity        bigint       not null,
  outcome         text         not null check (outcome in ('prepared','rejected','executed')),
  -- Which risk rule rejected it, when it was rejected.
  reject_reason   varchar(500) null,
  recorded_at     timestamptz  not null default now()
);
create index if not exists idx_prepared_trader on prepared_order (trader, recorded_at);
alter table prepared_order enable row level security;

create table if not exists trade_event (
  -- PENDING: no writer exists yet; defined so an indexer has a target.
  id            bigint generated always as identity primary key,
  tx_digest     varchar(80) not null,
  event_seq     integer     not null,
  market_id     varchar(80) not null,
  maker         varchar(80) not null,
  taker         varchar(80) not null,
  price         bigint      not null,
  quantity      bigint      not null,
  chain_timestamp_ms bigint not null,
  recorded_at   timestamptz not null default now(),

  -- An indexer replaying from a checkpoint will re-deliver events; this
  -- makes reprocessing safe.
  constraint uq_trade_event unique (tx_digest, event_seq)
);
create index if not exists idx_trade_market on trade_event (market_id, chain_timestamp_ms);
alter table trade_event enable row level security;

create table if not exists position_snapshot (
  -- PENDING: same reason as trade_event.
  id            bigint generated always as identity primary key,
  market_id     varchar(80) not null,
  trader        varchar(80) not null,
  -- Signed: positive is net long, negative is net short.
  net_contracts bigint      not null,
  entry_price   bigint      not null,
  chain_timestamp_ms bigint not null,
  recorded_at   timestamptz not null default now(),

  constraint uq_position_market_trader unique (market_id, trader)
);
create index if not exists idx_position_trader on position_snapshot (trader);
alter table position_snapshot enable row level security;
