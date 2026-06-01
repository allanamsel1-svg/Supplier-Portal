-- Variable expense rows: monthly amount = ROUND(sales_rate * Gross Sales, 0).
alter table public.financial_plan add column if not exists sales_rate numeric default null;
update public.financial_plan set sales_rate=0.06 where plan_year=1 and line_item='Licensing Fees';
update public.financial_plan set sales_rate=0.03 where plan_year=1 and line_item='Sales Commissions';
update public.financial_plan set sales_rate=0.01 where plan_year=1 and line_item='UGC';
update public.financial_plan set sales_rate=0.01 where plan_year=1 and line_item='UGC Placement';
update public.financial_plan set sales_rate=0.04 where plan_year=1 and line_item='Fulfillment (3rd Party)';
