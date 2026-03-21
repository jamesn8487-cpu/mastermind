-- ══════════════════════════════════════════
--  MasterMind — Supabase Schema
--  Go to: Supabase → SQL Editor → New Query
--  Paste this entire file and click Run
-- ══════════════════════════════════════════

-- Single table stores each user's entire app state as JSON
create table if not exists user_data (
  id         uuid primary key default gen_random_uuid(),
  clerk_id   text unique not null,
  data       jsonb not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Auto-update timestamp
create or replace function update_updated_at()
returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

create trigger user_data_updated_at
  before update on user_data
  for each row execute function update_updated_at();

-- Row Level Security
alter table user_data enable row level security;

-- Allow anon key to read/write (clerk_id checked in app code)
create policy "Allow all for anon key"
  on user_data for all
  using (true)
  with check (true);

-- Index for fast lookups
create index if not exists user_data_clerk_idx on user_data(clerk_id);
