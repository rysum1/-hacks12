-- ===========================================================================
-- Pygmalion's 100% Authentic Sculpting Experience: gallery database setup.
-- Run this ONCE in your Supabase project: Dashboard → SQL Editor → New query
-- → paste this whole file → Run.
--
-- Security model (no accounts):
--   * Anyone can read visible sculptures and publish new ones.
--   * Nobody can edit or delete rows directly. Likes, reports and deletes go
--     through the functions below, which only do that one thing.
--   * Deleting needs the publisher's private browser key; only its SHA-256
--     hash is stored.
--   * A sculpture reported 3 times is hidden automatically.
-- ===========================================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.sculptures (
  id          uuid primary key,
  created_at  timestamptz not null default now(),
  title       text not null check (char_length(title)  between 1 and 60),
  artist      text not null check (char_length(artist) between 1 and 40),
  likes       integer not null default 0,
  reports     integer not null default 0,
  hidden      boolean not null default false,
  owner_hash  text not null check (owner_hash ~ '^[0-9a-f]{64}$'),
  remix_of    uuid references public.sculptures(id) on delete set null,
  data_path   text not null,
  thumb_path  text not null
);
create index if not exists sculptures_newest on public.sculptures (created_at desc) where not hidden;
create index if not exists sculptures_liked  on public.sculptures (likes desc, created_at desc) where not hidden;

alter table public.sculptures enable row level security;

drop policy if exists "read visible sculptures" on public.sculptures;
create policy "read visible sculptures" on public.sculptures
  for select to anon, authenticated using (not hidden);

drop policy if exists "publish sculptures" on public.sculptures;
create policy "publish sculptures" on public.sculptures
  for insert to anon, authenticated
  with check (
    likes = 0 and reports = 0 and not hidden
    and data_path  = id::text || '.sclp'
    and thumb_path in (id::text || '.webp', id::text || '.png')
  );
-- (No update or delete policies on purpose.)

-- Like: +1, returns the new count.
create or replace function public.like_sculpture(sid uuid) returns integer
language sql security definer set search_path = public as $$
  update sculptures set likes = likes + 1 where id = sid and not hidden returning likes;
$$;

-- Report: +1; hidden once it reaches 3 reports.
create or replace function public.report_sculpture(sid uuid) returns void
language sql security definer set search_path = public as $$
  update sculptures
     set reports = reports + 1, hidden = hidden or reports + 1 >= 3
   where id = sid;
$$;

-- Delete (hides it) - only with the key of the browser that published it.
create or replace function public.delete_sculpture(sid uuid, owner_token text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  update sculptures set hidden = true
   where id = sid and owner_hash = encode(digest(owner_token, 'sha256'), 'hex');
  return found;
end $$;

revoke all on function public.like_sculpture(uuid), public.report_sculpture(uuid), public.delete_sculpture(uuid, text) from public;
grant execute on function public.like_sculpture(uuid), public.report_sculpture(uuid), public.delete_sculpture(uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- File storage: one public bucket for sculpture files (.sclp) and pictures.
-- Files are small (typically 5-60 KB); the limit is 3 MB each.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sculptures', 'sculptures', true, 3145728,
        array['application/octet-stream', 'image/webp', 'image/png'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "upload sculpture files" on storage.objects;
create policy "upload sculpture files" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'sculptures' and name ~ '^[0-9a-f-]{36}\.(sclp|webp|png)$');
-- Public bucket: files are readable by URL. No update/delete policies, so
-- uploads can't be overwritten or removed from the website.
