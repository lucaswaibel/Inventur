create table if not exists public.app_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

drop policy if exists "app_state_read_anon" on public.app_state;
drop policy if exists "app_state_write_anon" on public.app_state;
drop policy if exists "app_state_update_anon" on public.app_state;

create policy "app_state_read_anon"
on public.app_state
for select
to anon
using (id = 'main');

create policy "app_state_write_anon"
on public.app_state
for insert
to anon
with check (id = 'main');

create policy "app_state_update_anon"
on public.app_state
for update
to anon
using (id = 'main')
with check (id = 'main');
