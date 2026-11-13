-- Silica Compute Index (SCI) snapshots. One row per cron snapshot; the
-- server is the only writer/reader (service role), so RLS is enabled with no
-- policies. Idempotent: safe to re-run.

create table if not exists compute_index_snapshots (
  id                  bigint generated always as identity primary key,
  taken_at            timestamptz not null default now(),
  level               numeric not null,
  components          jsonb not null,
  methodology_version text not null
);

create index if not exists compute_index_snapshots_taken_at_idx
  on compute_index_snapshots (taken_at);

alter table compute_index_snapshots enable row level security;
