-- ════════════════════════════════════════════════════════════════════
-- projection_skus — TBG product projection / COGS modelling
--
-- elc and the two margin columns are STORED generated columns. Note:
-- Postgres does not allow a generated column to reference another, so
-- tbg_margin inlines the ELC formula rather than referencing the elc column.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.projection_skus (
  id                    uuid primary key default gen_random_uuid(),
  projection_group      text default 'TBG Year 1 Consumables',
  product_line          text,
  item_description      text,
  size_unit             text,
  coo                   text default 'China',
  bulk_unit_cost        numeric,
  packaging             numeric,
  inner_carton_qty      integer,
  master_carton_qty     integer,
  opening_order_qty     integer,
  hts_code              text,
  duty_rate             numeric,
  tariff_rate           numeric,
  warehouse_broker_fees numeric,
  container_qty         integer,
  container_cost        numeric,
  estimated_freight     numeric,
  elc numeric generated always as
    ((bulk_unit_cost + packaging) * (1 + duty_rate + tariff_rate) + estimated_freight) stored,
  wholesale_price       numeric,
  proposed_sell_price   numeric,
  comp_retail_price     numeric,
  customer_margin numeric generated always as
    (case when comp_retail_price > 0 then (comp_retail_price - wholesale_price) / comp_retail_price else 0 end) stored,
  tbg_margin numeric generated always as
    (case when wholesale_price > 0
       then (wholesale_price - ((bulk_unit_cost + packaging) * (1 + duty_rate + tariff_rate) + estimated_freight)) / wholesale_price
       else 0 end) stored,
  status                text default 'proposed',
  notes                 text,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

alter table public.projection_skus enable row level security;
drop policy if exists "allow_all" on public.projection_skus;
create policy "allow_all" on public.projection_skus for all using (true) with check (true);

create index if not exists idx_projection_skus_line on public.projection_skus(product_line);
