-- Local Music — cloud library schema (migration 0001)
--
-- Design notes (spec §4):
--  * Primary keys are TEXT and intentionally equal to the client-generated,
--    stable track ids used locally (UUIDs where available). Sync is therefore
--    idempotent: an upsert by id never duplicates a track or playlist.
--  * Rows carry user_id ownership and every table is RLS-protected. A user
--    can never read or write another user's metadata, let alone their audio.
--  * Only R2 OBJECT KEYS are stored. Presigned URLs are never persisted:
--    they are generated on demand by the Worker and are short-lived.
--  * Audio bytes live in R2, not Postgres.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tracks
-- ---------------------------------------------------------------------------
create table if not exists public.tracks (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  object_key text,                       -- R2 key for the audio object (nullable)
  artwork_object_key text,               -- R2 key for the artwork object, if uploaded
  title text not null default '',
  artist text not null default '',
  album text not null default '',
  track_number integer,
  album_track_count integer,
  duration_ms bigint,
  file_name text not null default '',
  file_size bigint not null default 0,
  mime_type text not null default '',
  fingerprint text,                      -- size + partial hash; duplicate detection
  metadata_from_filename boolean not null default false,
  is_liked boolean not null default false,
  play_count integer not null default 0,
  last_played_at timestamptz,
  added_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tracks_id_user_id_key unique (id, user_id)
);

-- One cloud audio object per track per user.
create unique index if not exists tracks_object_key_user_idx
  on public.tracks (user_id, object_key) where object_key is not null;

-- Duplicate detection and library listing.
create index if not exists tracks_user_fingerprint_idx on public.tracks (user_id, fingerprint);
create index if not exists tracks_user_updated_idx on public.tracks (user_id, updated_at desc);
create index if not exists tracks_user_last_played_idx on public.tracks (user_id, last_played_at desc);

-- ---------------------------------------------------------------------------
-- Playlists
-- ---------------------------------------------------------------------------
create table if not exists public.playlists (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint playlists_id_user_id_key unique (id, user_id)
);

create index if not exists playlists_user_idx on public.playlists (user_id, updated_at desc);

-- Ordered playlist membership. (playlist_id, track_id) is the natural key, so
-- re-syncing a playlist updates rows in place instead of appending copies.
-- Composite foreign keys ensure playlist and track are owned by the exact same user.
create table if not exists public.playlist_tracks (
  playlist_id text not null,
  track_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  position integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (playlist_id, track_id),
  foreign key (playlist_id, user_id) references public.playlists (id, user_id) on delete cascade,
  foreign key (track_id, user_id) references public.tracks (id, user_id) on delete cascade
);

create index if not exists playlist_tracks_playlist_position_idx on public.playlist_tracks (playlist_id, position);

-- ---------------------------------------------------------------------------
-- Lyrics
-- ---------------------------------------------------------------------------
create type public.lyric_capability as enum ('word', 'line', 'plain', 'instrumental');

create table if not exists public.track_lyrics (
  track_id text primary key references public.tracks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  format text not null default 'lrc' check (format in ('lrc', 'txt')),
  lines jsonb not null default '[]'::jsonb,    -- [{ timeMs, text, words?: [{text,startMs,endMs}] }]
  offset_ms integer not null default 0,        -- user timing offset; original data is never rewritten
  skipped_lines integer not null default 0,
  source_name text not null default '',
  origin jsonb,                                -- { kind, recordId, fetchedAt, matchedTitle, matchedArtist, matchedAlbum, capability }
  updated_at timestamptz not null default now()
);

create index if not exists track_lyrics_user_idx on public.track_lyrics (user_id);

-- ---------------------------------------------------------------------------
-- Playback metadata (per-user counters and positions)
-- ---------------------------------------------------------------------------
create table if not exists public.track_playback (
  track_id text primary key references public.tracks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  play_count integer not null default 0,
  last_played_at timestamptz,
  position_ms bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at ()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['tracks', 'playlists', 'track_lyrics', 'track_playback']
  loop
    begin
      execute format('create trigger trg_%1$s_touch_updated_at before update on public.%1$s for each row execute function public.touch_updated_at();', tbl);
    exception when duplicate_object then
      null; -- trigger already exists (re-runnable migration)
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.tracks enable row level security;
alter table public.playlists enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.track_lyrics enable row level security;
alter table public.track_playback enable row level security;

-- Tracks: a user sees and manages only their own rows.
drop policy if exists "tracks_select_own" on public.tracks;
create policy "tracks_select_own" on public.tracks
  for select using (auth.uid() = user_id);

drop policy if exists "tracks_insert_own" on public.tracks;
create policy "tracks_insert_own" on public.tracks
  for insert with check (auth.uid() = user_id);

drop policy if exists "tracks_update_own" on public.tracks;
create policy "tracks_update_own" on public.tracks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "tracks_delete_own" on public.tracks;
create policy "tracks_delete_own" on public.tracks
  for delete using (auth.uid() = user_id);

-- Playlists
drop policy if exists "playlists_select_own" on public.playlists;
create policy "playlists_select_own" on public.playlists
  for select using (auth.uid() = user_id);

drop policy if exists "playlists_insert_own" on public.playlists;
create policy "playlists_insert_own" on public.playlists
  for insert with check (auth.uid() = user_id);

drop policy if exists "playlists_update_own" on public.playlists;
create policy "playlists_update_own" on public.playlists
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "playlists_delete_own" on public.playlists;
create policy "playlists_delete_own" on public.playlists
  for delete using (auth.uid() = user_id);

-- Playlist membership: membership must agree with the owning playlist's user.
drop policy if exists "playlist_tracks_select_own" on public.playlist_tracks;
create policy "playlist_tracks_select_own" on public.playlist_tracks
  for select using (auth.uid() = user_id);

drop policy if exists "playlist_tracks_insert_own" on public.playlist_tracks;
create policy "playlist_tracks_insert_own" on public.playlist_tracks
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = auth.uid())
    and exists (select 1 from public.tracks t where t.id = track_id and t.user_id = auth.uid())
  );

drop policy if exists "playlist_tracks_update_own" on public.playlist_tracks;
create policy "playlist_tracks_update_own" on public.playlist_tracks
  for update using (auth.uid() = user_id) with check (
    auth.uid() = user_id
    and exists (select 1 from public.playlists p where p.id = playlist_id and p.user_id = auth.uid())
    and exists (select 1 from public.tracks t where t.id = track_id and t.user_id = auth.uid())
  );

drop policy if exists "playlist_tracks_delete_own" on public.playlist_tracks;
create policy "playlist_tracks_delete_own" on public.playlist_tracks
  for delete using (auth.uid() = user_id);

-- Lyrics
drop policy if exists "track_lyrics_select_own" on public.track_lyrics;
create policy "track_lyrics_select_own" on public.track_lyrics
  for select using (auth.uid() = user_id);

drop policy if exists "track_lyrics_insert_own" on public.track_lyrics;
create policy "track_lyrics_insert_own" on public.track_lyrics
  for insert with check (auth.uid() = user_id);

drop policy if exists "track_lyrics_update_own" on public.track_lyrics;
create policy "track_lyrics_update_own" on public.track_lyrics
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "track_lyrics_delete_own" on public.track_lyrics;
create policy "track_lyrics_delete_own" on public.track_lyrics
  for delete using (auth.uid() = user_id);

-- Playback metadata
drop policy if exists "track_playback_select_own" on public.track_playback;
create policy "track_playback_select_own" on public.track_playback
  for select using (auth.uid() = user_id);

drop policy if exists "track_playback_insert_own" on public.track_playback;
create policy "track_playback_insert_own" on public.track_playback
  for insert with check (auth.uid() = user_id);

drop policy if exists "track_playback_update_own" on public.track_playback;
create policy "track_playback_update_own" on public.track_playback
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "track_playback_delete_own" on public.track_playback;
create policy "track_playback_delete_own" on public.track_playback
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Defensive belt-and-braces: ownership invariants hold even if a client
-- somehow bypasses the RLS check predicates (e.g. via a future trigger or a
-- copy operation). auth.uid() is the only authority here — never a
-- client-supplied id.
-- ---------------------------------------------------------------------------
create or replace function public.assert_owning_user ()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'cannot change row ownership';
  end if;
  if new.user_id is distinct from auth.uid() then
    raise exception 'row must belong to the authenticated user';
  end if;
  return new;
end;
$$;

do $$
declare
  tbl text;
begin
  foreach tbl in array array['tracks', 'playlists', 'playlist_tracks', 'track_lyrics', 'track_playback']
  loop
    begin
      execute format(
        'create trigger trg_%1$s_assert_owner before insert or update on public.%1$s '
        'for each row execute function public.assert_owning_user();', tbl);
    exception when duplicate_object then
      null;
    end;
  end loop;
end;
$$;

-- Keep playlist membership consistent with its playlist's owner and track's owner.
create or replace function public.assert_playlist_membership_owner ()
returns trigger
language plpgsql
as $$
declare
  pl_owner uuid;
  tr_owner uuid;
begin
  select user_id into pl_owner from public.playlists where id = new.playlist_id;
  if pl_owner is null or pl_owner is distinct from new.user_id then
    raise exception 'playlist membership must match the playlist owner';
  end if;

  select user_id into tr_owner from public.tracks where id = new.track_id;
  if tr_owner is null or tr_owner is distinct from new.user_id then
    raise exception 'playlist membership must match the track owner';
  end if;

  return new;
end;
$$;

do $$
begin
  begin
    create trigger trg_playlist_tracks_assert_playlist_owner
      before insert or update on public.playlist_tracks
      for each row execute function public.assert_playlist_membership_owner();
  exception when duplicate_object then
    null;
  end;
end;
$$;
