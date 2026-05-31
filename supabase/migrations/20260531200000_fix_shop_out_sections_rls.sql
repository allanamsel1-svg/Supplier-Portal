-- ════════════════════════════════════════════════════════════════════
-- Fix shop_out_sections RLS
--
-- The original section_annotations migration left shop_out_sections with
-- anon = SELECT only, so the browser (which writes with the anon key, like
-- the rest of this app) could not persist section annotations
-- (category_override / section_comment / ai_accuracy_flag) — PostgREST
-- silently updated 0 rows.
--
-- Align with the other shop_out tables, which all use a single permissive
-- "allow_all" policy.
-- ════════════════════════════════════════════════════════════════════

drop policy if exists "shop_out_sections_anon_select" on public.shop_out_sections;
drop policy if exists "shop_out_sections_service_all" on public.shop_out_sections;
drop policy if exists "allow_all" on public.shop_out_sections;

create policy "allow_all" on public.shop_out_sections
  for all using (true) with check (true);
