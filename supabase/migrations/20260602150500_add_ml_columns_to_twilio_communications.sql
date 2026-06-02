-- ML-ready columns for the communications log.
alter table public.twilio_communications add column if not exists thread_id text;            -- groups related messages in a conversation
alter table public.twilio_communications add column if not exists sentiment_score double precision; -- reserved for ML, nullable
alter table public.twilio_communications add column if not exists response_time_hours double precision; -- inbound → next outbound, same factory
alter table public.twilio_communications add column if not exists channel_preference text;    -- factory's fastest-responding channel at log time
alter table public.twilio_communications add column if not exists word_count integer;
alter table public.twilio_communications add column if not exists has_attachment boolean default false;

create index if not exists idx_twilio_comms_thread on public.twilio_communications(thread_id);
