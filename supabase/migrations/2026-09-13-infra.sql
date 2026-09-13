-- Infrastructure hardening, 2026-09-13. Not applied automatically: review, then apply through the
-- Supabase MCP (`apply_migration`) or `pnpm db:apply`. Every statement is idempotent.

-- ---------- Community counters: one clone per wallet, atomic increments ----------
-- `clones` used to move on an unauthenticated POST by a read-modify-write; two clicks racing lost
-- one, and a script could count a thousand. A clone is now one row per (basket, wallet), so the
-- count is a fact about wallets rather than about requests.
create table if not exists public.basket_clones (
  basket_id  text not null references public.baskets (id) on delete cascade,
  cloner     text not null,
  created_at timestamptz not null default now(),
  primary key (basket_id, cloner)
);
alter table public.basket_clones enable row level security;
revoke all on public.basket_clones from anon, authenticated;

-- Move a basket counter by `p_delta` in one statement and return the new value, clamped at zero.
-- `p_column` is whitelisted, not interpolated: the server passes 'votes' or 'clones' and anything
-- else is refused. Runs as the caller (service role); no SECURITY DEFINER in the exposed schema.
create or replace function public.increment_basket_counter(p_id text, p_column text, p_delta integer)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare new_value integer;
begin
  if p_column = 'votes' then
    update public.baskets set votes = greatest(0, votes + p_delta), updated_at = now() where id = p_id returning votes into new_value;
  elsif p_column = 'clones' then
    update public.baskets set clones = greatest(0, clones + p_delta), updated_at = now() where id = p_id returning clones into new_value;
  else
    raise exception 'increment_basket_counter: unknown column %', p_column;
  end if;
  return new_value;
end;
$$;
revoke all on function public.increment_basket_counter(text, text, integer) from public, anon, authenticated;

-- ---------- Retention ----------
-- The maintenance sweep deletes `error_events` older than 14 days (by `last_at`, already indexed)
-- and `ai_usage` daily counters older than 7 days (by `day`); this index keeps that delete from
-- scanning the whole table as the counters accumulate.
create index if not exists ai_usage_day_idx on public.ai_usage (day);

-- ---------- Handles ----------
-- Handle lookups are exact (`eq`) on the lowercased handle the server stores. Profiles written
-- before handles were normalised are folded to lower case so an exact match still finds them.
update public.profiles set handle = lower(handle) where handle is not null and handle <> lower(handle);
