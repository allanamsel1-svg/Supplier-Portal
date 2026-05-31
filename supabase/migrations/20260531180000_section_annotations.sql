-- ════════════════════════════════════════════════════════════════════
-- Section annotation layer
--
-- Adds manual reviewer annotations to shop_out_sections:
--   section_comment   — freeform reviewer notes
--   category_override — human-corrected category (AI value kept in
--                       category_detected for comparison)
--   ai_accuracy_flag  — reviewer judgement of the AI read:
--                       'correct' | 'close' | 'missed' | null
--
-- All nullable; existing rows unaffected.
-- ════════════════════════════════════════════════════════════════════

alter table public.shop_out_sections
  add column if not exists section_comment   text,
  add column if not exists category_override text,
  add column if not exists ai_accuracy_flag  text;
