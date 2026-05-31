-- ════════════════════════════════════════════════════════════════════
-- shop_out_sections
--
-- Stores AI analysis of wide-angle "section" photos (a shelf run / aisle /
-- department) captured during a shop-out, alongside the existing
-- product-level shop_out_observations.
--
-- All new columns are nullable so existing rows are unaffected.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.shop_out_sections (
  id                    uuid primary key default gen_random_uuid(),
  shop_out_id           uuid references public.shop_outs(id) on delete cascade,
  section_photo_id      uuid references public.shop_out_photos(id) on delete set null,
  department            text,
  category_detected     text,
  estimated_linear_feet numeric,
  brand_summary         jsonb,
  ai_confidence         numeric,
  ai_extraction_json    jsonb,
  sequence_number       integer,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- Link product photos and observations back to the section they belong to.
alter table public.shop_out_photos
  add column if not exists section_id uuid references public.shop_out_sections(id) on delete set null;

alter table public.shop_out_observations
  add column if not exists section_id uuid references public.shop_out_sections(id) on delete set null;

-- Helpful indexes for the lookups the UI performs.
create index if not exists idx_shop_out_sections_shop_out_id
  on public.shop_out_sections(shop_out_id);
create index if not exists idx_shop_out_photos_section_id
  on public.shop_out_photos(section_id);
create index if not exists idx_shop_out_observations_section_id
  on public.shop_out_observations(section_id);

-- ─── Row Level Security ─────────────────────────────────────────────
alter table public.shop_out_sections enable row level security;

-- service_role: full access (bypasses RLS anyway, but explicit for clarity)
drop policy if exists "shop_out_sections_service_all" on public.shop_out_sections;
create policy "shop_out_sections_service_all"
  on public.shop_out_sections
  for all
  to service_role
  using (true)
  with check (true);

-- anon: read-only (the browser UI reads sections with the anon key)
drop policy if exists "shop_out_sections_anon_select" on public.shop_out_sections;
create policy "shop_out_sections_anon_select"
  on public.shop_out_sections
  for select
  to anon
  using (true);
