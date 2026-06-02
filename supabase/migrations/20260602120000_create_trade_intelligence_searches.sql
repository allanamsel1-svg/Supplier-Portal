-- ════════════════════════════════════════════════════════════════════
-- trade_intelligence_searches — audit log of Trade Intelligence lookups
-- (USITC HTS + CBP CROSS rulings) performed from trade_intelligence.html.
-- One row per search; either hts_code/keyword (HTS lookup) or
-- ruling_number/keyword (CROSS lookup) is populated.
-- ════════════════════════════════════════════════════════════════════
create table if not exists public.trade_intelligence_searches (
  id            uuid primary key default gen_random_uuid(),
  hts_code      text,
  keyword       text,
  ruling_number text,
  searched_at   timestamptz default now(),
  admin_id      text
);

alter table public.trade_intelligence_searches enable row level security;
drop policy if exists "allow_all" on public.trade_intelligence_searches;
create policy "allow_all" on public.trade_intelligence_searches for all using (true) with check (true);

create index if not exists idx_tis_searched_at on public.trade_intelligence_searches(searched_at desc);
