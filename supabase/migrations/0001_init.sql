-- Silica schema, Postgres (Supabase).
--
-- The API server is the only client: it records prepared/rejected orders
-- here, and the compute index snapshots live in 0003. Indexed chain events
-- would also live here.
--
-- Not every table below is populated yet. The ones fed by an existing
-- data source are marked LIVE; the ones waiting on an unbuilt indexer
-- are marked PENDING. Do not mistake a PENDING table's existence for it
-- having data.
--
-- Conventions:
--   * Chain/protocol timestamps are stored as bigint, exactly as the
--     source reports them (seconds or milliseconds, noted per column),
--     not converted to timestamptz, because converting loses the source's
--     own notion of time.
--   * `recorded_at` is this database's own wall-clock insert time, kept
--     separate from those protocol timestamps for the same reason.
--   * Money-ish and ratio values use numeric, never float.
--   * Row level security is enabled on every table with no policies. Only
--     the server connects, with a role that bypasses RLS (the Supabase
--     service/DB role), so anon/authenticated API keys see nothing.
--   * Idempotent: safe to re-run.
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
