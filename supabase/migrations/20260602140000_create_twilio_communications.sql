-- ════════════════════════════════════════════════════════════════════
-- twilio_communications — log of all SMS / voice / fax / whatsapp messages
-- (inbound + outbound) exchanged via Twilio, linked to a factory when matched.
-- ════════════════════════════════════════════════════════════════════
create table if not exists public.twilio_communications (
  id          uuid primary key default gen_random_uuid(),
  factory_id  uuid,
  direction   text,   -- inbound | outbound
  channel     text,   -- sms | voice | fax | whatsapp
  to_number   text,
  from_number text,
  body        text,
  status      text,
  twilio_sid  text,
  created_at  timestamptz default now()
);

alter table public.twilio_communications enable row level security;
drop policy if exists "allow_all" on public.twilio_communications;
create policy "allow_all" on public.twilio_communications for all using (true) with check (true);

create index if not exists idx_twilio_comms_factory on public.twilio_communications(factory_id, created_at desc);
create index if not exists idx_twilio_comms_sid on public.twilio_communications(twilio_sid);
