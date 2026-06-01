-- Salary positions feeding Payroll / Contract Labor lines in the Financial Plan.
create table if not exists public.financial_plan_positions (
  id             uuid primary key default gen_random_uuid(),
  plan_year      integer,
  line_item      text,
  position_title text,
  annual_salary  numeric,
  start_month    integer,
  is_active      boolean default true,
  created_at     timestamptz default now()
);
alter table public.financial_plan_positions enable row level security;
drop policy if exists "allow_all" on public.financial_plan_positions;
create policy "allow_all" on public.financial_plan_positions for all using (true) with check (true);
create index if not exists idx_fpp_line on public.financial_plan_positions(plan_year, line_item);
