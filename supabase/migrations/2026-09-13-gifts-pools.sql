-- Gift pools: rotate the reconciliation sweep through every open pool.
--
-- `sweepOpenPools` reads a bounded batch of open pools per run. Ordered newest-first, the same
-- twenty-five pools were read every time and an older open pool was never reached. The sweep now
-- stamps each pool it visits and takes the least recently visited first (never visited first of
-- all), so a bounded run still covers every open pool over a few cycles.
--
-- The code tolerates this column being absent (it falls back to created_at ordering and the stamp
-- is a no-op), so this can be applied before or after the deploy.
alter table public.gift_pools add column if not exists last_reconciled_at timestamptz;

-- The sweep's own query: open pools, oldest visit first.
create index if not exists gift_pools_open_sweep_idx
  on public.gift_pools (last_reconciled_at asc nulls first, created_at asc)
  where status in ('submitted', 'live');

-- The public directory and the creator's list now count only rows that are claims
-- (`confirmed`, `reconciled`), in one grouped query per page of pools.
create index if not exists gift_pool_claims_pool_status_idx on public.gift_pool_claims (pool_id, status);
