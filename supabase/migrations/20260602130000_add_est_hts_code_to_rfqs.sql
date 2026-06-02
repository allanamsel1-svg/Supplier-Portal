-- Gap #1: the RFQ AI duty/tariff suggestion (suggestDutyTariff in admin.html)
-- generates an HTS code but the RFQ had nowhere to store it. The PD costing
-- sheet seed already reads rfqs.est_hts_code (admin.html), so persist it here.
alter table public.rfqs add column if not exists est_hts_code text;
