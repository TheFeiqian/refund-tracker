-- ============================================================
-- Refund Tracker — Supabase schema
-- Model: single shared workspace for a trusted internal team.
-- Everyone must log in (real auth), and all authenticated users
-- share one dataset (orders, stores, files). Audit columns record
-- who changed what. Swap the RLS policies later if you ever need
-- per-user / per-client isolation.
-- ============================================================

-- ---- Profiles (mirrors auth.users, for names in the audit trail) ----
create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  email      text,
  name       text,
  role       text default 'member',   -- 'admin' | 'member'
  created_at timestamptz default now()
);

-- Auto-create a profile row when a user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', new.email))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- Stores (the store registry / method-logic inputs) ----
create table if not exists public.stores (
  name                  text primary key,
  unwanted              boolean,            -- parcel-shop label for unwanted goods -> LIT
  damaged               boolean,            -- parcel-shop label for damaged goods  -> LIT with pic
  collection            boolean,            -- offers home collection (BBM large items)
  cat                   text[] default '{}',-- categories: clothes / tech / large furniture items / home items
  inbound_courier       text,               -- informs RTS
  return_label_courier  text,               -- informs LIT / LIT with pic
  revenue               numeric,            -- yearly revenue (drives budget)
  contact               jsonb,              -- {phone,email,portal,chat}
  updated_at            timestamptz default now(),
  updated_by            uuid references auth.users
);

-- ---- Orders (full order object kept as jsonb for parity with the app) ----
create table if not exists public.orders (
  order_id    text primary key,
  data        jsonb not null default '{}'::jsonb,  -- fields + triggers + file references
  updated_at  timestamptz default now(),
  updated_by  uuid references auth.users
);
create index if not exists orders_store_idx on public.orders ((data->>'store'));

-- ---- Files (label/receipt metadata; bytes live in Storage bucket 'labels') ----
create table if not exists public.files (
  id            uuid primary key default gen_random_uuid(),
  order_id      text references public.orders(order_id) on delete cascade,
  field         text,            -- e.g. proof_of_postage, return_label_pdf, order_confirmation, delivery_photo
  storage_path  text not null,   -- path within the 'labels' bucket
  filename      text,
  filetype      text,
  size          bigint,
  uploaded_at   timestamptz default now(),
  uploaded_by   uuid references auth.users
);
create index if not exists files_order_idx on public.files (order_id);

-- ---- Audit log (who/when/what) ----
create table if not exists public.audit_log (
  id        bigint generated always as identity primary key,
  at        timestamptz default now(),
  actor     uuid references auth.users,
  entity    text,        -- 'order' | 'store' | 'file'
  entity_id text,
  action    text,        -- 'upsert' | 'delete' | 'upload' | 'stage_change'
  detail    jsonb
);

-- ============================================================
-- Row Level Security — authenticated = full access (shared workspace)
-- ============================================================
alter table public.profiles  enable row level security;
alter table public.stores    enable row level security;
alter table public.orders    enable row level security;
alter table public.files     enable row level security;
alter table public.audit_log enable row level security;

-- profiles: anyone signed in can read; you can only write your own
drop policy if exists "read profiles" on public.profiles;
create policy "read profiles" on public.profiles
  for select to authenticated using (true);
drop policy if exists "upsert own profile" on public.profiles;
create policy "upsert own profile" on public.profiles
  for all to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- stores / orders / files: shared workspace — any signed-in user can do anything
drop policy if exists "stores all" on public.stores;
create policy "stores all" on public.stores
  for all to authenticated using (true) with check (true);

drop policy if exists "orders all" on public.orders;
create policy "orders all" on public.orders
  for all to authenticated using (true) with check (true);

drop policy if exists "files all" on public.files;
create policy "files all" on public.files
  for all to authenticated using (true) with check (true);

-- audit: signed-in users can read and append
drop policy if exists "audit read" on public.audit_log;
create policy "audit read" on public.audit_log
  for select to authenticated using (true);
drop policy if exists "audit insert" on public.audit_log;
create policy "audit insert" on public.audit_log
  for insert to authenticated with check (true);

-- ============================================================
-- Storage policies for the 'labels' bucket
-- (Create the bucket first — see README — named exactly: labels, private)
-- ============================================================
drop policy if exists "labels read"   on storage.objects;
create policy "labels read"   on storage.objects
  for select to authenticated using (bucket_id = 'labels');
drop policy if exists "labels insert" on storage.objects;
create policy "labels insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'labels');
drop policy if exists "labels update" on storage.objects;
create policy "labels update" on storage.objects
  for update to authenticated using (bucket_id = 'labels');
drop policy if exists "labels delete" on storage.objects;
create policy "labels delete" on storage.objects
  for delete to authenticated using (bucket_id = 'labels');

-- ============================================================
-- app_state: shared key/value (e.g. weekly burndown history)
-- ============================================================
create table if not exists public.app_state (
  key text primary key,
  value jsonb,
  updated_at timestamptz default now()
);
alter table public.app_state enable row level security;
drop policy if exists "app_state all" on public.app_state;
create policy "app_state all" on public.app_state
  for all to authenticated using (true) with check (true);

-- ============================================================
-- notifications: written by the sla-reminders function; the app can show them
-- ============================================================
create table if not exists public.notifications (
  id bigint generated by default as identity primary key,
  at timestamptz default now(),
  order_id text,
  task_code text,
  assignee text,
  channel text,            -- 'email' | 'slack' | 'in_app'
  status text,             -- 'pending' | 'sent' | 'failed'
  detail text
);
alter table public.notifications enable row level security;
drop policy if exists "notifications read" on public.notifications;
create policy "notifications read" on public.notifications
  for select to authenticated using (true);
drop policy if exists "notifications insert" on public.notifications;
create policy "notifications insert" on public.notifications
  for insert to authenticated with check (true);
