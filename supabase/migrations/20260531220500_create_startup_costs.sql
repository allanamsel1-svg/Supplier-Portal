create table if not exists public.startup_costs (
  id               uuid primary key default gen_random_uuid(),
  item_description text,
  category         text,
  amount_projected numeric,
  amount_actual    numeric default null,
  is_active        boolean default true,
  is_edited        boolean default false,
  baseline_amount  numeric,
  notes            text,
  created_at       timestamptz default now()
);
alter table public.startup_costs enable row level security;
drop policy if exists "allow_all" on public.startup_costs;
create policy "allow_all" on public.startup_costs for all using (true) with check (true);
