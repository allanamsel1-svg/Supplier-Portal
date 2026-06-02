-- Public bucket for outbound fax PDFs. Twilio fetches MediaUrl over the public
-- internet, so the object must be publicly readable.
insert into storage.buckets (id, name, public)
values ('twilio-fax', 'twilio-fax', true)
on conflict (id) do update set public = true;

-- Allow uploads/reads on this bucket (admin uploads via anon key; reads public).
drop policy if exists "twilio_fax_all" on storage.objects;
create policy "twilio_fax_all" on storage.objects
  for all using (bucket_id = 'twilio-fax') with check (bucket_id = 'twilio-fax');
