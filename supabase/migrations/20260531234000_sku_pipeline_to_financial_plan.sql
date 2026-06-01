-- Connect the SKU pipeline to the Financial Plan.
-- Adds the SKU fields that drive the dynamic Inventory Purchasing and
-- Gross Sales (Active SKUs) rows, backfills existing SKUs, and removes the
-- hardcoded aggregate revenue rows from financial_plan (now computed in the UI
-- from status='active' SKUs).

alter table public.projection_skus
  add column if not exists order_qty_month3      integer,
  add column if not exists order_qty_month7      integer,
  add column if not exists order_qty_month12     integer,
  add column if not exists sales_units_per_month numeric,
  add column if not exists sales_start_month     integer,
  add column if not exists tabled_reason         text;

update public.projection_skus set
  order_qty_month3      = coalesce(order_qty_month3,8000),
  order_qty_month7      = coalesce(order_qty_month7,9000),
  order_qty_month12     = coalesce(order_qty_month12,8000),
  sales_units_per_month = coalesce(sales_units_per_month,2000),
  sales_start_month     = coalesce(sales_start_month,6);

delete from public.financial_plan
  where plan_year=1 and line_item in ('Gross Sales','Closeout Discount','Trade Allowances','Net Realized Sales');
