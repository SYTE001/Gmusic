-- Local Music — cloud library schema (migration 0002)
-- Adds description field to tracks for library metadata editing and cross-device sync.

alter table public.tracks
  add column if not exists description text not null default '';
