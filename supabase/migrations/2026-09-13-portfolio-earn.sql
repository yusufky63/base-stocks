-- 2026-09-13 · Portfolio, Earn, Automate, Stats
--
-- Indexes the hot queries were missing, and three SQL functions that replace table-wide scans the
-- application used to do in JavaScript. Everything is idempotent; the code tolerates the functions
-- being absent (it falls back to the slow path), so this can be applied at any time.

-- ---------- Indexes ----------
-- The statistics' live window and the rollup job read records by creation time across all wallets;
-- the existing (wallet, created_at) indexes do not serve a query with no wallet in it.
create index if not exists trade_records_created_idx on public.trade_records (created_at);
create index if not exists gifts_created_idx         on public.gifts (created_at);
create index if not exists earn_actions_created_idx  on public.earn_actions (created_at);

-- Every rule read is by wallet; the keeper's read is by mode and status.
create index if not exists automation_rules_wallet_idx on public.automation_rules (wallet_address);
create index if not exists automation_rules_mode_status_idx on public.automation_rules ((config_json->>'mode'), status);

-- ---------- Distinct wallets, counted by the database ----------
-- `/api/stats` used to page every table into the process to count distinct addresses. One query.
create or replace function public.stats_distinct_wallets()
returns table (portfolio_wallets bigint, known_wallets bigint)
language sql
stable
security invoker
set search_path = public
as $$
  with known as (
    select lower(wallet_address) as w from public.trade_records
    union select lower(sender)          from public.gifts
    union select lower(recipient)       from public.gifts
    union select lower(wallet_address)  from public.portfolio_executions
    union select lower(wallet_address)  from public.earn_actions
    union select lower(creator)         from public.gift_pools
    union select lower(claimant)        from public.gift_pool_claims
    union select lower(wallet_address)  from public.automation_rules
    union select lower(wallet_address)  from public.profiles
    union select lower(owner)           from public.baskets
    union select lower(wallet_address)  from public.portfolio_snapshots
    union select lower(wallet)          from public.wallet_index
  )
  select
    (select count(distinct lower(wallet_address)) from public.portfolio_snapshots) as portfolio_wallets,
    (select count(*) from known where w ~ '^0x[0-9a-f]{40}$' and w <> '0x0000000000000000000000000000000000000000') as known_wallets;
$$;
revoke all on function public.stats_distinct_wallets() from public, anon, authenticated;

-- The same set as a list, for the Earn reconciliation sweep (it filters venue events by wallet).
create or replace function public.stats_known_wallets()
returns table (wallet text)
language sql
stable
security invoker
set search_path = public
as $$
  with known as (
    select lower(wallet_address) as w from public.trade_records
    union select lower(sender)          from public.gifts
    union select lower(recipient)       from public.gifts
    union select lower(wallet_address)  from public.portfolio_executions
    union select lower(wallet_address)  from public.earn_actions
    union select lower(creator)         from public.gift_pools
    union select lower(claimant)        from public.gift_pool_claims
    union select lower(wallet_address)  from public.automation_rules
    union select lower(wallet_address)  from public.profiles
    union select lower(owner)           from public.baskets
    union select lower(wallet_address)  from public.portfolio_snapshots
    union select lower(wallet)          from public.wallet_index
  )
  select w from known where w ~ '^0x[0-9a-f]{40}$' and w <> '0x0000000000000000000000000000000000000000';
$$;
revoke all on function public.stats_known_wallets() from public, anon, authenticated;

-- ---------- Every Earn venue anyone has used ----------
-- A Morpho vault that drops out of discovery's top twenty still holds deposits; the verifier and the
-- position reader learn about it from the records, with one DISTINCT instead of a table read.
create or replace function public.earn_distinct_opportunities()
returns table (opportunity_id text, provider text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct opportunity_id, provider from public.earn_actions;
$$;
revoke all on function public.earn_distinct_opportunities() from public, anon, authenticated;
