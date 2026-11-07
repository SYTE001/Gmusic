-- RLS policy tests for the cloud library schema.
--
-- How to run (requires the Supabase CLI, which provisions a local Postgres
-- with the auth schema and pgTAP):
--
--   supabase start
--   supabase db reset            # applies supabase/migrations/*
--   supabase test db --db-url "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     --files supabase/tests/rls_policies.test.sql
--
-- These tests were NOT executed in this environment: no local Postgres or
-- Supabase CLI is available here. They are provided so the authorization
-- policies can be verified as part of any real deployment.

begin;

-- Two distinct users.
insert into auth.users (id, email, encrypted_password, role, aud, instance_id)
values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com', 'x', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com', 'x', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

-- Fixture builder that always stamps the row with the acting user.
create or replace function pgtap_setup() returns void language plpgsql as $$
begin
  -- Track owned by A (with a cloud object key; never a presigned URL).
  insert into public.tracks (id, user_id, title, artist, object_key, file_name, file_size)
  values ('track-a', '11111111-1111-1111-1111-111111111111', 'Song A', 'Artist A',
          'users/11111111-1111-1111-1111-111111111111/tracks/track-a/audio.mp3', 'a.mp3', 1000);

  insert into public.playlists (id, user_id, name) values ('pl-a', '11111111-1111-1111-1111-111111111111', 'A mixes');
  insert into public.playlist_tracks (playlist_id, track_id, user_id, position)
  values ('pl-a', 'track-a', '11111111-1111-1111-1111-111111111111', 0);

  insert into public.track_lyrics (track_id, user_id, format, lines, offset_ms, source_name)
  values ('track-a', '11111111-1111-1111-1111-111111111111', 'lrc',
          '[{"timeMs": 0, "text": "line one"}]'::jsonb, 0, 'a.lrc');

  insert into public.track_playback (track_id, user_id, play_count, position_ms)
  values ('track-a', '11111111-1111-1111-1111-111111111111', 3, 12000);
end;
$$;

select pgtap_setup();

-- Act as user A.
set role postgres;
select plan(35);

-- -------- Selection isolation --------
select is(
  (select count(*) from public.tracks),
  1::bigint, 'before impersonation, the service role sees the seeded row'
);
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claim.role = 'authenticated';

select is((select count(*) from public.tracks), 1::bigint, 'user A sees their own track');
select is((select count(*) from public.playlists), 1::bigint, 'user A sees their own playlist');
select is((select count(*) from public.playlist_tracks), 1::bigint, 'user A sees their own playlist membership');
select is((select count(*) from public.track_lyrics), 1::bigint, 'user A sees their own lyrics');
select is((select count(*) from public.track_playback), 1::bigint, 'user A sees their own playback row');

-- Switch to user B without touching any data.
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

select is((select count(*) from public.tracks), 0::bigint, 'user B cannot see user A tracks');
select is((select count(*) from public.playlists), 0::bigint, 'user B cannot see user A playlists');
select is((select count(*) from public.playlist_tracks), 0::bigint, 'user B cannot see user A playlist membership');
select is((select count(*) from public.track_lyrics), 0::bigint, 'user B cannot see user A lyrics');
select is((select count(*) from public.track_playback), 0::bigint, 'user B cannot see user A playback');

-- -------- Insert: user B may not write into user A's namespace --------
select throws_ok(
  $$insert into public.tracks (id, user_id, title) values ('track-b-impostor', '11111111-1111-1111-1111-111111111111', 'stolen')$$,
  42501, 'new row violates row-level security policy',
  'insert into another user id is denied');

select lives_ok(
  $$insert into public.tracks (id, user_id, title) values ('track-b', '22222222-2222-2222-2222-222222222222', 'Song B')$$,
  'insert into own user id is allowed');

-- -------- Update: cross-user modification is denied --------
select throws_ok(
  $$update public.tracks set title = 'hacked' where id = 'track-a'$$,
  42501, 'no policy matches',
  'update of another user row is denied');

select lives_ok(
  $$update public.tracks set title = 'Song B v2' where id = 'track-b'$$,
  'update of own row is allowed');

-- -------- Delete: cross-user deletion is denied --------
select throws_ok(
  $$delete from public.tracks where id = 'track-a'$$,
  42501, 'no policy matches',
  'delete of another user row is denied');

-- -------- Referential integrity and ownership on playlist membership --------
-- 1. User B may not add their track to User A's playlist (cross-user playlist)
select throws_ok(
  $$insert into public.playlist_tracks (playlist_id, track_id, user_id, position)
    values ('pl-a', 'track-b', '22222222-2222-2222-2222-222222222222', 0)$$,
  42501,
  NULL,
  'adding track to another user playlist is denied');

-- Create a playlist owned by user B
select lives_ok(
  $$insert into public.playlists (id, user_id, name) values ('pl-b', '22222222-2222-2222-2222-222222222222', 'B mixes')$$,
  'create playlist for user B is allowed');

-- 2. User B may not link User A's track into User B's playlist (cross-user track)
select throws_ok(
  $$insert into public.playlist_tracks (playlist_id, track_id, user_id, position)
    values ('pl-b', 'track-a', '22222222-2222-2222-2222-222222222222', 0)$$,
  42501,
  NULL,
  'adding another user track to own playlist is denied');

-- 3. Valid same-user relationship: User B links User B's track into User B's playlist
select lives_ok(
  $$insert into public.playlist_tracks (playlist_id, track_id, user_id, position)
    values ('pl-b', 'track-b', '22222222-2222-2222-2222-222222222222', 0)$$,
  'valid same-user playlist membership is allowed');

select is(
  (select count(*) from public.playlist_tracks where playlist_id = 'pl-b' and user_id = '22222222-2222-2222-2222-222222222222'),
  1::bigint,
  'user B sees their valid playlist membership');

-- 4. Updating row ownership is rejected
select throws_ok(
  $$update public.tracks set user_id = '11111111-1111-1111-1111-111111111111' where id = 'track-b'$$,
  'P0001',
  'cannot change row ownership',
  'attempting to change row user_id is denied');

-- 5. Cascade delete behavior: deleting playlist pl-b cascades membership
select lives_ok(
  $$delete from public.playlists where id = 'pl-b'$$,
  'deleting playlist pl-b is allowed');

select is(
  (select count(*) from public.playlist_tracks where playlist_id = 'pl-b'),
  0::bigint,
  'deleting playlist cascades playlist_tracks deletion');

-- Clean up track-b
select lives_ok(
  $$delete from public.tracks where id = 'track-b'$$,
  'delete of own row is allowed');

-- -------- Idempotent sync shape: upsert by stable id does not duplicate --------
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select lives_ok(
  $$insert into public.tracks (id, user_id, title, artist)
    values ('track-a', '11111111-1111-1111-1111-111111111111', 'Song A (remaster)', 'Artist A')
    on conflict (id) do update set title = excluded.title$$,
  'upserting the same stable id reuses the row');
select is(
  (select count(*) from public.tracks where id = 'track-a'), 1::bigint,
  're-syncing a track does not duplicate it');
select is(
  (select title from public.tracks where id = 'track-a'), 'Song A (remaster)',
  'the re-sync carried the updated metadata');
select is(
  (select count(*) from public.playlist_tracks where playlist_id = 'pl-a'), 1::bigint,
  're-syncing a playlist does not duplicate membership');

-- -------- Object keys are stored, presigned URLs never are --------
select has_column('public.tracks', 'object_key', 'tracks carry an R2 object key');
select hasnt_column('public.tracks', 'play_url', 'presigned playback URLs are not persisted');
select hasnt_column('public.tracks', 'upload_url', 'presigned upload URLs are not persisted');

-- -------- Ownership columns exist on every user-scoped table --------
select has_column('public.tracks', 'user_id', 'tracks record ownership');
select has_column('public.playlists', 'user_id', 'playlists record ownership');
select has_column('public.playlist_tracks', 'user_id', 'playlist_tracks record ownership');
select has_column('public.track_lyrics', 'user_id', 'track_lyrics record ownership');
select has_column('public.track_playback', 'user_id', 'track_playback record ownership');

select finish();

rollback;
