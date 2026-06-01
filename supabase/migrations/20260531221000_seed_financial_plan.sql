-- Seed startup_costs (10 one-time items; baseline = projected).
insert into public.startup_costs (item_description, category, amount_projected, amount_actual, baseline_amount)
select item_description, category, amount_projected, amount_actual, amount_projected
from (values
  ('Office Equipment & Furnishing','One-Time',5000,5000),
  ('Corporate Filing Fees','One-Time',3000,3000),
  ('Professional Fees - Trademarks, Corporate Setup','One-Time',10000,10000),
  ('Import Warehousing Bond','One-Time',2500,2500),
  ('Insurance Fees','One-Time',3000,3000),
  ('Phone','One-Time',1000,1000),
  ('Accounting Software','One-Time',1000,1000),
  ('Customs Bond','One-Time',2500,2500),
  ('Unanticipated Costs (10% of Total)','One-Time',5300,5300),
  ('Licensing Up Front Costs','One-Time',25000,25000)
) as x(item_description, category, amount_projected, amount_actual);

-- Seed financial_plan Year 1 (monthly). baseline = projected.
insert into public.financial_plan (plan_year, month_number, line_item, category, amount_projected, baseline_amount, amount_actual, is_active, is_edited)
select 1, v.month_number, x.line_item, x.category, v.amount, v.amount, null, true, false
from (values
  ('Product Development / Samples','Operating Expense', array[4000,3000,3000,1000,1000,1500,1500,1500,1500,1500,1500,1500]),
  ('Product Development Travel','Operating Expense', array[13000,0,0,13000,0,0,13000,0,0,13000,0,0]),
  ('Domestic Travel & Customer Acquisition','Operating Expense', array[0,0,0,1000,1000,1000,1000,1000,1000,1000,1000,1000]),
  ('Package Design & Marketing Materials','Operating Expense', array[500,500,500,500,500,500,500,500,500,500,500,500]),
  ('Inspections','Operating Expense', array[0,0,0,0,0,3000,3000,3000,3000,3000,3000,3000]),
  ('Insurance (Business)','Operating Expense', array[2500,2500,2500,2500,2500,2500,2500,2500,2500,2500,2500,2500]),
  ('Trade Shows','Operating Expense', array[0,0,0,0,0,0,0,15000,0,0,0,0]),
  ('Payroll','Operating Expense', array[34167,34167,34167,34167,34167,38333,38333,38333,38333,38333,38333,38333]),
  ('Professional Services','Operating Expense', array[1500,1500,1500,1500,3500,4000,4000,4000,4000,4000,4000,4000]),
  ('Contract Labor (Fractional CFO / Controller)','Operating Expense', array[0,0,0,0,0,3500,3500,3500,3500,3500,3500,3500]),
  ('State Tax Filing & Corporate Compliance','Operating Expense', array[0,0,0,0,0,0,417,417,417,417,417,417]),
  ('Supplies (Office / Operating)','Operating Expense', array[500,500,500,500,500,500,500,500,500,500,500,500]),
  ('Rent','Operating Expense', array[2600,2600,2600,2600,2600,2600,2600,2600,2600,2600,2600,2600]),
  ('Fulfillment (3rd Party)','Operating Expense', array[0,0,0,0,0,14500,14500,14500,14500,14500,14500,14500]),
  ('UGC','Operating Expense', array[0,0,0,0,0,3625,3625,3625,3625,3625,3625,3625]),
  ('UGC Placement','Operating Expense', array[0,0,0,0,0,3625,3625,3625,3625,3625,3625,3625]),
  ('Licensing Fees','Operating Expense', array[0,0,0,0,0,21750,21750,21750,21750,21750,21750,21750]),
  ('Sales Commissions','Operating Expense', array[0,0,0,0,0,10875,10875,10875,10875,10875,10875,10875]),
  ('Gross Sales','Revenue', array[0,0,0,0,0,362500,362500,362500,362500,362500,362500,362500]),
  ('Closeout Discount','Revenue', array[0,0,0,0,0,31719,31719,31719,31719,31719,31719,31719]),
  ('Trade Allowances','Revenue', array[0,0,0,0,0,10875,10875,10875,10875,10875,10875,10875]),
  ('Net Realized Sales','Revenue', array[0,0,0,0,0,319906,319906,319906,319906,319906,319906,319906])
) as x(line_item, category, vals)
cross join lateral unnest(x.vals) with ordinality as v(amount, month_number);
