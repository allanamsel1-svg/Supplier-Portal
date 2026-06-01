create table if not exists public.financial_plan (
  id               uuid primary key default gen_random_uuid(),
  plan_year        integer,
  month_number     integer check (month_number between 1 and 12),
  line_item        text,
  category         text,
  amount_projected numeric,
  amount_actual    numeric default null,
  is_active        boolean default true,
  is_edited        boolean default false,
  baseline_amount  numeric,
  notes            text,
  created_at       timestamptz default now(),
  unique (plan_year, month_number, line_item)
);
alter table public.financial_plan enable row level security;
drop policy if exists "allow_all" on public.financial_plan;
create policy "allow_all" on public.financial_plan for all using (true) with check (true);
create index if not exists idx_financial_plan_year on public.financial_plan(plan_year);
