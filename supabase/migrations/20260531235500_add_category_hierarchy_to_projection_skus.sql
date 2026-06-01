-- Category hierarchy for projection_skus (category > sub_category > sub_sub_category).
-- Idempotent: if the columns already exist (populated externally) this preserves them;
-- otherwise it adds them and seeds the top level from product_line.
alter table public.projection_skus
  add column if not exists category         text,
  add column if not exists sub_category     text,
  add column if not exists sub_sub_category text;

update public.projection_skus set category = coalesce(category, product_line);
