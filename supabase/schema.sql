-- BStocks: application schema (Supabase / PostgreSQL)
-- Funds and keys never touch this database. All tables are written by the server-only
-- service client. RLS is enabled everywhere with NO public policies, so anon/authenticated
-- roles cannot read or write anything through the Data API.
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere).

create extension if not exists pgcrypto;

create table if not exists public.users (
  wallet_address   text primary key,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz,
  preferences_json jsonb not null default '{}'::jsonb
);

create table if not exists public.watchlists (
  id             uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  asset_address  text not null,
  created_at     timestamptz not null default now(),
  unique (wallet_address, asset_address)
);
create index if not exists watchlists_wallet_idx on public.watchlists (wallet_address);

create table if not exists public.portfolio_templates (
  id          text primary key,
  slug        text not null unique,
  name        text not null,
  description text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.portfolio_template_allocations (
  template_id           text not null references public.portfolio_templates (id) on delete cascade,
  asset_address_or_usdc text not null,
  weight_bps            integer not null check (weight_bps > 0 and weight_bps <= 10000),
  primary key (template_id, asset_address_or_usdc)
);

create table if not exists public.portfolio_executions (
  id             text primary key,
  wallet_address text not null,
  status         text not null,
  total_usd      numeric(18, 2) not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists portfolio_executions_wallet_idx on public.portfolio_executions (wallet_address, created_at desc);

create table if not exists public.portfolio_execution_steps (
  id               text primary key,
  execution_id     text not null references public.portfolio_executions (id) on delete cascade,
  asset_address    text not null,
  symbol           text,
  target_usd       numeric(18, 2) not null,
  sell_amount_usdc text not null,
  provider         text,
  status           text not null,
  tx_hash          text,
  error_code       text,
  error_message    text,
  created_at       timestamptz not null default now()
);
alter table public.portfolio_execution_steps add column if not exists side text not null default 'buy';
alter table public.portfolio_execution_steps add column if not exists sell_amount text;
create index if not exists portfolio_execution_steps_exec_idx on public.portfolio_execution_steps (execution_id);

create table if not exists public.gifts (
  id                 text primary key,
  kind               text not null,
  sender             text not null,
  recipient          text not null,
  recipient_basename text,
  asset_address      text not null,
  raw_amount         text not null,
  message            text,
  memo               text not null,
  tx_hash            text,
  status             text not null,
  created_at         timestamptz not null default now()
);
create index if not exists gifts_sender_idx on public.gifts (sender, created_at desc);
create index if not exists gifts_recipient_idx on public.gifts (recipient, created_at desc);

create table if not exists public.trade_records (
  id             text primary key,
  wallet_address text not null,
  side           text not null check (side in ('buy', 'sell')),
  asset_address  text not null,
  sell_amount    text not null,
  buy_amount     text not null,
  usd_value      numeric(18, 2),
  provider       text not null,
  tx_hash        text,
  status         text not null,
  recipient      text,
  created_at     timestamptz not null default now()
);
create index if not exists trade_records_wallet_idx on public.trade_records (wallet_address, created_at desc);

-- Earn deposits / withdrawals recorded by the app after wallet submission (verified by receipt in the activity service)
create table if not exists public.earn_actions (
  id             text primary key,
  wallet_address text not null,
  opportunity_id text not null,
  provider       text not null,
  action         text not null check (action in ('deposit', 'withdraw')),
  amount         text not null,
  usd_value      numeric(18, 2),
  tx_hash        text,
  created_at     timestamptz not null default now()
);
create index if not exists earn_actions_wallet_idx on public.earn_actions (wallet_address, created_at desc);
alter table public.earn_actions enable row level security;

create table if not exists public.activity_cache (
  id             text primary key,
  wallet_address text not null,
  tx_hash        text not null,
  type           text not null,
  metadata_json  jsonb not null default '{}'::jsonb,
  block_number   bigint,
  created_at     timestamptz not null default now()
);
create index if not exists activity_cache_wallet_idx on public.activity_cache (wallet_address, block_number desc);

create table if not exists public.discovered_assets (
  address        text primary key,
  name           text,
  symbol         text,
  block_number   bigint,
  verification   text not null default 'discovered' check (verification in ('discovered', 'verified', 'disabled')),
  -- Filled by discovery: underlying ticker, Chainlink "Coinbase <TICKER>" feed, tags; eligible = looks like a Coinbase stock (feed + oracle registry)
  underlying     text,
  chainlink_feed text,
  tags           text[] not null default '{}',
  eligible       boolean not null default false,
  auto_verified  boolean not null default false,
  creator        text,
  reason         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- AI helper quotas: per-key daily counters (key = ip:<hash> | wallet:<address> | global).
create table if not exists public.ai_usage (
  key        text not null,
  day        date not null,
  count      integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (key, day)
);

-- Atomic increment used by the server (returns the new count). Runs as the caller (service role);
-- no SECURITY DEFINER in the exposed schema.
create or replace function public.ai_usage_increment(p_key text, p_day date)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare new_count integer;
begin
  insert into public.ai_usage (key, day, count, updated_at)
  values (p_key, p_day, 1, now())
  on conflict (key, day) do update set count = public.ai_usage.count + 1, updated_at = now()
  returning count into new_count;
  return new_count;
end;
$$;
revoke all on function public.ai_usage_increment(text, date) from public, anon, authenticated;

-- Later (automation): kept for schema parity with the spec.
create table if not exists public.automation_rules (
  id             text primary key,
  wallet_address text not null,
  type           text not null,
  config_json    jsonb not null default '{}'::jsonb,
  status         text not null default 'proposed',
  created_at     timestamptz not null default now()
);

-- RLS: enabled on every table, no policies => only the service role (server) can access.
alter table public.users                          enable row level security;
alter table public.watchlists                     enable row level security;
alter table public.portfolio_templates            enable row level security;
alter table public.portfolio_template_allocations enable row level security;
alter table public.portfolio_executions           enable row level security;
alter table public.portfolio_execution_steps      enable row level security;
alter table public.gifts                          enable row level security;
alter table public.trade_records                  enable row level security;
alter table public.activity_cache                 enable row level security;
alter table public.discovered_assets              enable row level security;
alter table public.ai_usage                       enable row level security;
alter table public.automation_rules               enable row level security;

-- Defense in depth: no Data API access for public roles even if the schema is exposed.
revoke all on all tables in schema public from anon, authenticated;

-- ---------- Community layer (public by default for now), referrals, portfolio history ----------
create table if not exists public.profiles (
  wallet_address text primary key,
  handle         text unique,
  display_name   text,
  bio            text,
  is_public      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.baskets (
  id               text primary key,
  owner            text not null,
  name             text not null,
  description      text not null default '',
  allocations_json jsonb not null,
  clones           integer not null default 0,
  votes            integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists baskets_votes_idx on public.baskets (votes desc, created_at desc);
create index if not exists baskets_owner_idx on public.baskets (owner);

create table if not exists public.basket_votes (
  basket_id  text not null references public.baskets (id) on delete cascade,
  voter      text not null,
  created_at timestamptz not null default now(),
  primary key (basket_id, voter)
);

create table if not exists public.referrals (
  referee        text primary key,
  referrer       text not null,
  first_trade_tx text,
  created_at     timestamptz not null default now()
);
create index if not exists referrals_referrer_idx on public.referrals (referrer);

create table if not exists public.portfolio_snapshots (
  wallet_address text not null,
  day            date not null,
  total_usd      numeric(18, 2) not null,
  holdings_json  jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  primary key (wallet_address, day)
);

alter table public.automation_rules add column if not exists next_run_at timestamptz;
alter table public.automation_rules add column if not exists last_run_at timestamptz;
alter table public.automation_rules add column if not exists updated_at timestamptz not null default now();

alter table public.profiles            enable row level security;
alter table public.baskets             enable row level security;
alter table public.basket_votes        enable row level security;
alter table public.referrals           enable row level security;
alter table public.portfolio_snapshots enable row level security;
revoke all on all tables in schema public from anon, authenticated;
