use super::models::*;
use super::repository::*;
use super::schema::*;
use super::PersistenceEngine;
use crate::lyrics::{Line, Word};
use image::{ImageBuffer, ImageFormat, Rgba};
use rusqlite::Connection;
use std::io::Cursor;

fn sample_png_bytes(color: u8) -> Vec<u8> {
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_fn(120, 120, |x, y| {
        Rgba([(x % 250) as u8, (y % 250) as u8, color, 255])
    });
    let mut buf = Vec::new();
    img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
        .unwrap();
    buf
}

fn make_track(id: &str, title: &str) -> TrackDto {
    TrackDto {
        id: id.into(),
        title: title.into(),
        artist: "Daft Punk".into(),
        album: "Discovery".into(),
        track_number: Some(1),
        album_track_count: Some(14),
        duration_ms: Some(320_000),
        file_name: format!("{id}.flac"),
        file_size: 12_345_678,
        mime_type: "audio/flac".into(),
        added_at: 1000,
        last_played_at: Some(2000),
        play_count: 3,
        is_liked: true,
        availability: "available".into(),
        access_mode: "desktop-path".into(),
        fingerprint: Some(format!("fp-{id}")),
        metadata_from_filename: false,
        broken: None,
        description: Some("Classic track".into()),
        updated_at: Some(2500),
        desktop_path: Some(format!("C:\\Music\\{id}.flac")),
        object_key: None,
        artwork_object_key: None,
        storage_provider: None,
        cloud_status: Some("local".into()),
        last_synced_at: None,
    }
}

#[test]
fn fresh_database_initialization_sets_pragmas_and_schema_v1() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("gmusic.sqlite3");
    let mut conn = open_and_initialize_db(&db_path).unwrap();

    assert_eq!(read_user_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
    let fk: i32 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1);

    let status = get_status(&mut conn).unwrap();
    assert_eq!(status.authority, "indexeddb");
    assert_eq!(status.schema_version, 1);
    assert!(status.integrity_ok);
    assert_eq!(status.track_count, 0);
}

#[test]
fn newer_schema_refusal_preserves_the_database_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("newer.sqlite3");
    let mut conn = open_and_initialize_db(&db_path).unwrap();
    let track = make_track("newer", "Newer Schema Track");
    put_tracks(&mut conn, std::slice::from_ref(&track)).unwrap();
    conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1)
        .unwrap();
    drop(conn);

    let err = open_and_initialize_db(&db_path).unwrap_err();
    assert!(err.contains("newer than supported"));

    let conn = Connection::open(&db_path).unwrap();
    assert_eq!(
        read_user_version(&conn).unwrap(),
        CURRENT_SCHEMA_VERSION + 1
    );
    assert_eq!(list_tracks(&conn).unwrap(), vec![track]);
}

#[test]
fn schema_upgrade_and_transactional_rollback_on_failure() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("upgrade.sqlite3");
    let mut conn = open_and_initialize_db(&db_path).unwrap();
    assert_eq!(read_user_version(&conn).unwrap(), 1);

    // Attempt a v2 upgrade that fails halfway -> must roll back table creation and keep user_version = 1
    let bad_steps = [(
        2,
        "CREATE TABLE test_v2 (id TEXT PRIMARY KEY); INVALID SQL STATEMENT HERE;",
    )];
    let res = apply_migrations_up_to(&mut conn, 2, &bad_steps);
    assert!(res.is_err());
    assert_eq!(read_user_version(&conn).unwrap(), 1);

    let table_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='test_v2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(table_exists, 0);

    // Now apply a valid v2 upgrade -> succeeds and updates user_version to 2
    let good_steps = [(2, "CREATE TABLE test_v2 (id TEXT PRIMARY KEY NOT NULL);")];
    let ver = apply_migrations_up_to(&mut conn, 2, &good_steps).unwrap();
    assert_eq!(ver, 2);
    assert_eq!(read_user_version(&conn).unwrap(), 2);
}

#[test]
fn track_playlist_lyrics_prefs_and_artwork_crud_preserves_ordering_and_relationships() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("crud.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();

    let t1 = make_track("t1", "One More Time");
    let t2 = make_track("t2", "Aerodynamic");
    let t3 = make_track("t3", "Digital Love");

    put_tracks(&mut conn, &[t1.clone(), t2.clone(), t3.clone()]).unwrap();
    let listed = list_tracks(&conn).unwrap();
    assert_eq!(listed.len(), 3);
    assert_eq!(get_track(&conn, "t2").unwrap(), Some(t2.clone()));

    // Playlist ordering preservation including duplicate/reordered positions
    let pl = PlaylistDto {
        id: "pl-1".into(),
        name: "Favourites".into(),
        description: "Ordered mix".into(),
        track_ids: vec!["t3".into(), "t1".into(), "t2".into()],
        created_at: 100,
        updated_at: 200,
    };
    put_playlist(&mut conn, &pl).unwrap();
    let loaded_pl = get_playlist(&conn, "pl-1").unwrap().unwrap();
    assert_eq!(loaded_pl.track_ids, vec!["t3", "t1", "t2"]);

    // Reorder playlist
    let pl_reordered = PlaylistDto {
        track_ids: vec!["t2".into(), "t3".into(), "t1".into()],
        updated_at: 300,
        ..pl
    };
    put_playlist(&mut conn, &pl_reordered).unwrap();
    assert_eq!(
        list_playlists(&conn).unwrap()[0].track_ids,
        vec!["t2", "t3", "t1"]
    );

    // Manual/accepted lyrics with word timing and user offsets
    let lyrics = TrackLyricsDto {
        track_id: "t1".into(),
        format: "lrc".into(),
        lines: vec![Line {
            time_ms: Some(1500),
            text: "One more time".into(),
            words: vec![
                Word {
                    text: "One ".into(),
                    start_ms: 1500,
                    end_ms: Some(1700),
                },
                Word {
                    text: "more ".into(),
                    start_ms: 1700,
                    end_ms: Some(1900),
                },
            ],
        }],
        offset_ms: -350,
        updated_at: 5000,
        skipped_lines: 0,
        source_name: "manual.lrc".into(),
        origin: Some(LyricOriginDto {
            kind: "manual".into(),
            record_id: serde_json::Value::Null,
            fetched_at: 5000,
            matched_title: None,
            matched_artist: None,
            matched_album: None,
            capability: "word".into(),
        }),
        schema_version: Some(2),
    };
    put_lyrics(&mut conn, &lyrics).unwrap();
    let loaded_lyrics = get_lyrics(&conn, "t1").unwrap().unwrap();
    assert_eq!(loaded_lyrics, lyrics);

    let meta = LyricsCacheMetaDto {
        track_id: "t1".into(),
        status: "accepted".into(),
        checked_at: 5000,
        record_id: Some(99),
        schema_version: 2,
        discovery_identity: Some("id-hash".into()),
    };
    put_lyrics_cache_meta(&mut conn, &meta).unwrap();
    assert_eq!(get_lyrics_cache_meta(&conn, "t1").unwrap(), Some(meta));

    // Artwork deduplicated via native artwork cache
    let png = sample_png_bytes(180);
    put_artwork(&mut conn, &art_dir, "t1", &png).unwrap();
    put_artwork(&mut conn, &art_dir, "t2", &png).unwrap();
    assert_eq!(
        list_artwork_track_ids(&conn).unwrap(),
        vec!["t1".to_string(), "t2".to_string()]
    );
    let (mime, loaded_art) = get_artwork(&conn, &art_dir, "t1").unwrap().unwrap();
    assert_eq!(mime, "image/png");
    assert!(!loaded_art.is_empty());

    // Delete track cleans up track, artwork_refs, lyrics, lyrics_meta, and pending-metadata-sync
    put_pref_json(
        &mut conn,
        "pending-metadata-sync",
        &serde_json::json!([
            { "trackId": "t1", "title": "One More Time", "description": "a", "queuedAt": 1 },
            { "trackId": "t2", "title": "Aerodynamic", "description": "b", "queuedAt": 2 }
        ]),
    )
    .unwrap();

    delete_tracks(&mut conn, &art_dir, &["t1".into()]).unwrap();
    assert!(get_track(&conn, "t1").unwrap().is_none());
    assert!(get_lyrics(&conn, "t1").unwrap().is_none());
    assert!(get_lyrics_cache_meta(&conn, "t1").unwrap().is_none());
    assert_eq!(
        list_artwork_track_ids(&conn).unwrap(),
        vec!["t2".to_string()]
    );
    let remaining_sync = get_pref_json(&conn, "pending-metadata-sync")
        .unwrap()
        .unwrap();
    assert_eq!(remaining_sync.as_array().unwrap().len(), 1);
}

#[test]
fn idb_migration_verifies_counts_and_checksum_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("mig.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();

    let t1 = make_track("t1", "Track 1");
    let t2 = make_track("t2", "Track 2");
    let pl = PlaylistDto {
        id: "p1".into(),
        name: "Mix".into(),
        description: "".into(),
        track_ids: vec!["t1".into(), "t2".into()],
        created_at: 1,
        updated_at: 2,
    };

    // Compute expected checksum using a temporary in-memory DB
    let mut temp_conn = Connection::open_in_memory().unwrap();
    configure_connection(&temp_conn).unwrap();
    apply_migrations(&mut temp_conn).unwrap();
    put_tracks(&mut temp_conn, &[t1.clone(), t2.clone()]).unwrap();
    put_playlist(&mut temp_conn, &pl).unwrap();
    let expected_checksum = compute_library_checksum(&temp_conn).unwrap();

    let begin_req = MigrationBeginRequest {
        migration_id: "mig-1".into(),
        expected_tracks: 2,
        expected_playlists: 1,
        expected_lyrics: 0,
        expected_lyrics_meta: 0,
        expected_prefs: 1,
        expected_artwork: 0,
        expected_audio: 0,
        expected_checksum: expected_checksum.clone(),
        force_reimport: false,
    };

    let st = begin_idb_migration(&mut conn, &begin_req).unwrap();
    assert_eq!(st.authority, "migrating");

    write_idb_migration_batch(
        &mut conn,
        &art_dir,
        &MigrationBatchRequest {
            migration_id: "mig-1".into(),
            tracks: vec![t1, t2],
            playlists: vec![pl],
            prefs: vec![PrefEntryDto {
                name: "app".into(),
                payload: serde_json::json!({"theme": "dark"}),
            }],
            ..Default::default()
        },
    )
    .unwrap();

    let final_st = finalize_idb_migration(&mut conn, "mig-1").unwrap();
    assert_eq!(final_st.authority, "sqlite");
    assert_eq!(final_st.track_count, 2);
    assert_eq!(final_st.playlist_count, 1);

    // Repeating begin_idb_migration with identical verified checksum is idempotent and preserves sqlite authority
    let repeat_st = begin_idb_migration(&mut conn, &begin_req).unwrap();
    assert_eq!(repeat_st.authority, "sqlite");
    assert_eq!(repeat_st.track_count, 2);
}

#[test]
fn interrupted_or_failed_migration_falls_back_to_recovery_required_and_recovers_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("interrupted.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();

    let t1 = make_track("t1", "Song 1");
    let begin_req = MigrationBeginRequest {
        migration_id: "mig-int".into(),
        expected_tracks: 2,
        expected_playlists: 0,
        expected_lyrics: 0,
        expected_lyrics_meta: 0,
        expected_prefs: 0,
        expected_artwork: 0,
        expected_audio: 0,
        expected_checksum: "dummy-checksum".into(),
        force_reimport: false,
    };

    begin_idb_migration(&mut conn, &begin_req).unwrap();
    write_idb_migration_batch(
        &mut conn,
        &art_dir,
        &MigrationBatchRequest {
            migration_id: "mig-int".into(),
            tracks: vec![t1.clone()],
            ..Default::default()
        },
    )
    .unwrap();

    // Simulate app crash / restart while authority == 'migrating':
    // Drop the old connection and reopen the database file on startup ->
    // open_and_initialize_db must detect the incomplete migration and transition to 'recovery-required'
    drop(conn);
    let mut conn = open_and_initialize_db(&db_path).unwrap();
    let startup_status = get_status(&mut conn).unwrap();
    assert_eq!(startup_status.authority, "recovery-required");
    assert!(startup_status.recovery_guidance.is_some());

    // Also test count mismatch on finalize transitions to recovery-required and clears partial tables
    begin_idb_migration(&mut conn, &begin_req).unwrap();
    write_idb_migration_batch(
        &mut conn,
        &art_dir,
        &MigrationBatchRequest {
            migration_id: "mig-int".into(),
            tracks: vec![t1.clone()],
            ..Default::default()
        },
    )
    .unwrap();
    let err = finalize_idb_migration(&mut conn, "mig-int").unwrap_err();
    assert!(err.contains("count mismatch"));
    let failed_status = get_status(&mut conn).unwrap();
    assert_eq!(failed_status.authority, "recovery-required");
    assert_eq!(failed_status.track_count, 0);

    // Now recover cleanly with complete data
    let mut temp_conn = Connection::open_in_memory().unwrap();
    configure_connection(&temp_conn).unwrap();
    apply_migrations(&mut temp_conn).unwrap();
    put_tracks(&mut temp_conn, std::slice::from_ref(&t1)).unwrap();
    let valid_cs = compute_library_checksum(&temp_conn).unwrap();

    begin_idb_migration(
        &mut conn,
        &MigrationBeginRequest {
            migration_id: "mig-recover".into(),
            expected_tracks: 1,
            expected_checksum: valid_cs,
            ..Default::default()
        },
    )
    .unwrap();
    write_idb_migration_batch(
        &mut conn,
        &art_dir,
        &MigrationBatchRequest {
            migration_id: "mig-recover".into(),
            tracks: vec![t1],
            ..Default::default()
        },
    )
    .unwrap();
    let recovered = finalize_idb_migration(&mut conn, "mig-recover").unwrap();
    assert_eq!(recovered.authority, "sqlite");
    assert_eq!(recovered.track_count, 1);
}

#[test]
fn large_library_migration_and_backup_replace_library_preserve_surviving_links() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("large.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();

    // Insert 1,200 tracks across 3 batches
    let total = 1200usize;
    let all_tracks: Vec<TrackDto> = (0..total)
        .map(|i| make_track(&format!("track-{i:04}"), &format!("Title {i}")))
        .collect();

    let mut temp_conn = Connection::open_in_memory().unwrap();
    configure_connection(&temp_conn).unwrap();
    apply_migrations(&mut temp_conn).unwrap();
    for chunk in all_tracks.chunks(400) {
        put_tracks(&mut temp_conn, chunk).unwrap();
    }
    let expected_cs = compute_library_checksum(&temp_conn).unwrap();

    begin_idb_migration(
        &mut conn,
        &MigrationBeginRequest {
            migration_id: "mig-large".into(),
            expected_tracks: total as i64,
            expected_checksum: expected_cs,
            ..Default::default()
        },
    )
    .unwrap();

    for chunk in all_tracks.chunks(400) {
        write_idb_migration_batch(
            &mut conn,
            &art_dir,
            &MigrationBatchRequest {
                migration_id: "mig-large".into(),
                tracks: chunk.to_vec(),
                ..Default::default()
            },
        )
        .unwrap();
    }

    let st = finalize_idb_migration(&mut conn, "mig-large").unwrap();
    assert_eq!(st.authority, "sqlite");
    assert_eq!(st.track_count, 1200);

    // Attach audio blob to track-0001 and track-0002, then replace_library keeping only track-0001
    put_audio_blob(&mut conn, "track-0001", "audio/flac", b"kept-audio").unwrap();
    put_audio_blob(&mut conn, "track-0002", "audio/flac", b"dropped-audio").unwrap();

    replace_library(
        &mut conn,
        &art_dir,
        &ReplaceLibraryRequest {
            tracks: vec![all_tracks[1].clone()],
            playlists: vec![],
            lyrics: vec![],
            preferences: Some(serde_json::json!({"theme": "light"})),
        },
    )
    .unwrap();

    assert_eq!(list_tracks(&conn).unwrap().len(), 1);
    assert!(get_audio_blob(&conn, "track-0001").unwrap().is_some());
    assert!(get_audio_blob(&conn, "track-0002").unwrap().is_none());
}

#[test]
fn detects_database_corruption_and_transitions_to_recovery_required() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("corrupt.sqlite3");
    {
        let mut conn = open_and_initialize_db(&db_path).unwrap();
        // Force a foreign key violation by disabling foreign_keys temporarily and inserting an orphan playlist_track
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES ('missing-pl', 0, 't1')",
            [],
        )
        .unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let st = get_status(&mut conn).unwrap();
        assert!(!st.integrity_ok);
        assert_eq!(st.authority, "recovery-required");
        assert!(!st.integrity_errors.is_empty());
    }
}

#[tokio::test]
async fn persistence_connection_work_does_not_block_async_progress() {
    let dir = tempfile::tempdir().unwrap();
    let engine = PersistenceEngine::new().unwrap();
    let path = dir.path().join("progress.sqlite3");
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let task = tokio::spawn(async move {
        engine
            .with_conn(path, move |conn| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                put_tracks(conn, &[make_track("progress", "Progress")])
            })
            .await
    });
    entered_rx.await.unwrap();
    // The current-thread runtime can release the deliberately blocked connection.
    tokio::task::yield_now().await;
    release_tx.send(()).unwrap();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn persistence_engine_handles_concurrent_access_without_blocking_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("concurrent.sqlite3");
    let engine = PersistenceEngine::new().unwrap();

    let mut handles = Vec::new();
    for i in 0..10 {
        let eng = engine.clone();
        let path = db_path.clone();
        handles.push(tokio::spawn(async move {
            let track = make_track(&format!("c-{i}"), &format!("Concurrent {i}"));
            eng.with_conn(path, move |conn| put_tracks(conn, &[track]))
                .await
                .unwrap();
        }));
    }
    for h in handles {
        h.await.unwrap();
    }

    let tracks = engine
        .with_conn(db_path, |conn| list_tracks(conn))
        .await
        .unwrap();
    assert_eq!(tracks.len(), 10);
}

#[test]
fn failed_atomic_track_import_removes_new_unreferenced_artwork_files() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("atomic_import.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();
    let track = make_track("atomic-fail", "Atomic Failure");
    let png = sample_png_bytes(91);

    conn.execute_batch(
        "CREATE TRIGGER reject_audio BEFORE INSERT ON audio_blobs BEGIN SELECT RAISE(ABORT, 'audio failure'); END;",
    )
    .unwrap();
    let result = put_track_with_files(
        &mut conn,
        &art_dir,
        &track,
        Some(&ArtworkMigrationEntryDto {
            track_id: track.id.clone(),
            mime_type: "image/png".into(),
            bytes: png,
            sha256: None,
        }),
        Some(&AudioMigrationEntryDto {
            track_id: track.id.clone(),
            mime_type: "audio/mpeg".into(),
            bytes: b"audio".to_vec(),
            sha256: None,
        }),
    );
    assert!(result.is_err());
    assert!(get_track(&conn, &track.id).unwrap().is_none());
    assert!(get_artwork(&conn, &art_dir, &track.id).unwrap().is_none());

    let persistent = dir.path().join("persistent-artwork-v1").join("blobs");
    assert_eq!(std::fs::read_dir(persistent).unwrap().count(), 0);
    assert_eq!(crate::artwork::cache::measure_cache_bytes(&art_dir), 0);
}

#[test]
fn failed_standalone_artwork_write_removes_disk_artifacts() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("artwork_failure.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER reject_artwork BEFORE INSERT ON artwork_refs BEGIN SELECT RAISE(ABORT, 'artwork failure'); END;",
    )
    .unwrap();

    assert!(put_artwork(&mut conn, &art_dir, "art-fail", &sample_png_bytes(77)).is_err());
    assert!(list_artwork_track_ids(&conn).unwrap().is_empty());
    assert_eq!(crate::artwork::cache::measure_cache_bytes(&art_dir), 0);
    let persistent = dir.path().join("persistent-artwork-v1").join("blobs");
    assert_eq!(std::fs::read_dir(persistent).unwrap().count(), 0);
}

#[test]
fn failed_migration_batch_removes_uncommitted_artwork_cache_entries() {
    use sha2::{Digest, Sha256};

    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("migration_artwork_failure.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();
    let png = sample_png_bytes(83);
    begin_idb_migration(
        &mut conn,
        &MigrationBeginRequest {
            migration_id: "mig-art-fail".into(),
            expected_artwork: 1,
            expected_audio: 1,
            expected_checksum: "empty".into(),
            ..Default::default()
        },
    )
    .unwrap();
    conn.execute_batch(
        "CREATE TRIGGER reject_migration_audio BEFORE INSERT ON audio_blobs BEGIN SELECT RAISE(ABORT, 'audio failure'); END;",
    )
    .unwrap();

    assert!(write_idb_migration_batch(
        &mut conn,
        &art_dir,
        &MigrationBatchRequest {
            migration_id: "mig-art-fail".into(),
            artwork: vec![ArtworkMigrationEntryDto {
                track_id: "migration-art".into(),
                mime_type: "image/png".into(),
                sha256: Some(format!("{:x}", Sha256::digest(&png))),
                bytes: png,
            }],
            audio: vec![AudioMigrationEntryDto {
                track_id: "migration-art".into(),
                mime_type: "audio/mpeg".into(),
                sha256: Some(format!("{:x}", Sha256::digest(b"audio"))),
                bytes: b"audio".to_vec(),
            }],
            ..Default::default()
        },
    )
    .is_err());
    assert_eq!(crate::artwork::cache::measure_cache_bytes(&art_dir), 0);
}

#[test]
fn failed_artwork_replacement_preserves_previous_cache_mapping() {
    use sha2::{Digest, Sha256};

    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("atomic_replace.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();
    let track = make_track("replace-fail", "Replacement Failure");
    let original = sample_png_bytes(41);
    let replacement = sample_png_bytes(142);
    put_track_with_files(
        &mut conn,
        &art_dir,
        &track,
        Some(&ArtworkMigrationEntryDto {
            track_id: track.id.clone(),
            mime_type: "image/png".into(),
            bytes: original.clone(),
            sha256: None,
        }),
        None,
    )
    .unwrap();

    conn.execute_batch(
        "CREATE TRIGGER reject_audio_replace BEFORE INSERT ON audio_blobs BEGIN SELECT RAISE(ABORT, 'audio failure'); END;",
    )
    .unwrap();
    assert!(put_track_with_files(
        &mut conn,
        &art_dir,
        &track,
        Some(&ArtworkMigrationEntryDto {
            track_id: track.id.clone(),
            mime_type: "image/png".into(),
            bytes: replacement,
            sha256: None,
        }),
        Some(&AudioMigrationEntryDto {
            track_id: track.id.clone(),
            mime_type: "audio/mpeg".into(),
            bytes: b"audio".to_vec(),
            sha256: None,
        }),
    )
    .is_err());

    let cached = crate::artwork::cache::read_cached_artwork(
        &art_dir,
        &format!("track::{}", track.id),
        false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        cached.content_hash.unwrap(),
        format!("{:x}", Sha256::digest(&original))
    );
}

#[test]
fn cached_track_upsert_rolls_back_sql_failure_and_remains_reusable() {
    let dir = tempfile::tempdir().unwrap();
    let mut conn = open_and_initialize_db(&dir.path().join("cached.sqlite3")).unwrap();
    let original = make_track("original", "Original");
    put_tracks(&mut conn, std::slice::from_ref(&original)).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_fixture BEFORE INSERT ON tracks WHEN NEW.id = 'reject' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;").unwrap();
    let update = make_track("original", "Should roll back");
    let rejected = make_track("reject", "Rejected");
    assert!(put_tracks(&mut conn, &[update, rejected]).is_err());
    assert_eq!(list_tracks(&conn).unwrap(), vec![original]);
    conn.execute_batch("DROP TRIGGER reject_fixture;").unwrap();
    let accepted = make_track("reject", "Accepted after rollback");
    put_tracks(&mut conn, std::slice::from_ref(&accepted)).unwrap();
    assert_eq!(get_track(&conn, "reject").unwrap(), Some(accepted));
    assert!(run_integrity_checks(&conn).unwrap().is_empty());
}

#[test]
fn rejects_duplicate_ids_and_malformed_records_and_preserves_missing_availability() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("validation.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();

    // Missing title or empty ID is rejected
    let mut bad_track = make_track("", "Valid Title");
    assert!(put_tracks(&mut conn, std::slice::from_ref(&bad_track)).is_err());

    bad_track = make_track("t-bad", "   ");
    assert!(put_tracks(&mut conn, &[bad_track]).is_err());

    // Unsupported availability or accessMode is rejected
    let mut bad_avail = make_track("t-avail", "Song");
    bad_avail.availability = "telepathic".into();
    assert!(put_tracks(&mut conn, &[bad_avail]).is_err());

    // Duplicate track IDs in replace_library are rejected and do not clobber existing data
    let valid_existing = make_track("t-keep", "Existing");
    put_tracks(&mut conn, std::slice::from_ref(&valid_existing)).unwrap();

    let dup_req = ReplaceLibraryRequest {
        tracks: vec![make_track("dup-1", "First"), make_track("dup-1", "Second")],
        playlists: vec![],
        lyrics: vec![],
        preferences: None,
    };
    assert!(replace_library(&mut conn, &art_dir, &dup_req).is_err());
    assert_eq!(list_tracks(&conn).unwrap(), vec![valid_existing]);

    // Missing audio file status is preserved accurately in SQLite
    let mut missing_track = make_track("t-missing", "Moved File");
    missing_track.availability = "missing".into();
    put_tracks(&mut conn, &[missing_track]).unwrap();
    assert_eq!(
        get_track(&conn, "t-missing").unwrap().unwrap().availability,
        "missing"
    );
}

#[test]
fn protects_authoritative_sqlite_data_from_stale_idb_snapshots_unless_force_reimport_is_set() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("authoritative.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();

    let t1 = make_track("t1", "Initial Title");
    let mut temp_conn = Connection::open_in_memory().unwrap();
    configure_connection(&temp_conn).unwrap();
    apply_migrations(&mut temp_conn).unwrap();
    put_tracks(&mut temp_conn, std::slice::from_ref(&t1)).unwrap();
    let stale_idb_cs = compute_library_checksum(&temp_conn).unwrap();

    // 1. Perform initial migration from IndexedDB -> SQLite becomes authoritative
    let begin_req = MigrationBeginRequest {
        migration_id: "mig-initial".into(),
        expected_tracks: 1,
        expected_checksum: stale_idb_cs.clone(),
        ..Default::default()
    };
    begin_idb_migration(&mut conn, &begin_req).unwrap();
    write_idb_migration_batch(
        &mut conn,
        &art_dir,
        &MigrationBatchRequest {
            migration_id: "mig-initial".into(),
            tracks: vec![t1],
            ..Default::default()
        },
    )
    .unwrap();
    let st = finalize_idb_migration(&mut conn, "mig-initial").unwrap();
    assert_eq!(st.authority, "sqlite");

    // 2. Mutate SQLite directly (user imports a new track and renames t1 on desktop)
    let t1_edited = make_track("t1", "Edited On Desktop");
    let t2_new = make_track("t2", "Imported On Desktop");
    put_tracks(&mut conn, &[t1_edited, t2_new]).unwrap();
    assert_eq!(list_tracks(&conn).unwrap().len(), 2);

    // 3. Call begin_idb_migration with the stale 1-track IndexedDB snapshot (force_reimport: false)
    // Must NOT wipe SQLite or revert to 1 track!
    let stale_req = MigrationBeginRequest {
        migration_id: "mig-stale-attempt".into(),
        expected_tracks: 1,
        expected_checksum: stale_idb_cs.clone(),
        force_reimport: false,
        ..Default::default()
    };
    let protected_st = begin_idb_migration(&mut conn, &stale_req).unwrap();
    assert_eq!(protected_st.authority, "sqlite");
    assert_eq!(protected_st.track_count, 2);
    assert_eq!(
        get_track(&conn, "t1").unwrap().unwrap().title,
        "Edited On Desktop"
    );

    // 4. Even if mark_migration_failed is mistakenly called while authority == 'sqlite', data is preserved
    let fail_st = mark_migration_failed(&mut conn, "accidental error").unwrap();
    assert_eq!(fail_st.authority, "sqlite");
    assert_eq!(fail_st.track_count, 2);

    // 5. Explicit force_reimport: true allows intentional re-migration
    let force_req = MigrationBeginRequest {
        migration_id: "mig-forced".into(),
        expected_tracks: 1,
        expected_checksum: stale_idb_cs,
        force_reimport: true,
        ..Default::default()
    };
    let forced_st = begin_idb_migration(&mut conn, &force_req).unwrap();
    assert_eq!(forced_st.authority, "migrating");
}

#[test]
fn persistent_artwork_survives_disposable_cache_pruning_and_cleans_up_only_when_unreferenced() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("art_persist.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();

    let t1 = make_track("t1", "Song 1");
    let t2 = make_track("t2", "Song 2");
    put_tracks(&mut conn, &[t1, t2]).unwrap();

    // Shared content-addressed artwork across t1 and t2
    let png = sample_png_bytes(99);
    put_artwork(&mut conn, &art_dir, "t1", &png).unwrap();
    put_artwork(&mut conn, &art_dir, "t2", &png).unwrap();

    // Aggressively prune disposable artwork-v1 cache to 0 bytes AND clear all disposable cache
    crate::artwork::cache::prune_cache(&art_dir, 0).unwrap();
    crate::artwork::cache::clear_all_cache(&art_dir).unwrap();

    // SQLite-owned artwork must STILL be available from persistent-artwork-v1/blobs!
    let (mime1, bytes1) = get_artwork(&conn, &art_dir, "t1").unwrap().unwrap();
    assert_eq!(mime1, "image/png");
    assert_eq!(bytes1, png);

    // Reopen connection (simulating app restart) -> artwork still available
    drop(conn);
    let mut conn = open_and_initialize_db(&db_path).unwrap();
    assert!(get_artwork(&conn, &art_dir, "t1").unwrap().is_some());

    // Delete t1 -> shared persistent blob must remain intact for t2
    delete_tracks(&mut conn, &art_dir, &["t1".into()]).unwrap();
    assert!(get_artwork(&conn, &art_dir, "t1").unwrap().is_none());
    let (_, bytes2) = get_artwork(&conn, &art_dir, "t2").unwrap().unwrap();
    assert_eq!(bytes2, png);

    // Delete t2 -> now unreferenced persistent blob is cleaned up from disk
    delete_tracks(&mut conn, &art_dir, &["t2".into()]).unwrap();
    assert!(get_artwork(&conn, &art_dir, "t2").unwrap().is_none());
    let p_blobs = dir.path().join("persistent-artwork-v1").join("blobs");
    let remaining_files = std::fs::read_dir(&p_blobs).unwrap().count();
    assert_eq!(remaining_files, 0);
}

#[test]
fn verifies_binary_sha256_on_migration_batches_and_rejects_missing_malformed_or_mismatched_digests()
{
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("sha_verify.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();

    let png = sample_png_bytes(44);

    // 1. Missing SHA-256 on artwork is rejected
    begin_idb_migration(
        &mut conn,
        &MigrationBeginRequest {
            migration_id: "mig-sha-missing".into(),
            expected_artwork: 1,
            expected_checksum: "empty".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let missing_art_err = write_idb_migration_batch(
        &mut conn,
        &art_dir,
        &MigrationBatchRequest {
            migration_id: "mig-sha-missing".into(),
            artwork: vec![ArtworkMigrationEntryDto {
                track_id: "t1".into(),
                mime_type: "image/png".into(),
                bytes: png.clone(),
                sha256: None,
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(missing_art_err.contains("Missing SHA-256 digest"));

    // 2. Malformed SHA-256 (wrong length / non-hex) on audio is rejected
    begin_idb_migration(
        &mut conn,
        &MigrationBeginRequest {
            migration_id: "mig-sha-malformed".into(),
            expected_audio: 1,
            expected_checksum: "empty".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let malformed_aud_err = write_idb_migration_batch(
        &mut conn,
        &art_dir,
        &MigrationBatchRequest {
            migration_id: "mig-sha-malformed".into(),
            audio: vec![AudioMigrationEntryDto {
                track_id: "t1".into(),
                mime_type: "audio/mpeg".into(),
                bytes: b"audio-bytes".to_vec(),
                sha256: Some("not-a-valid-64-char-hex-digest".into()),
            }],
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(malformed_aud_err.contains("Malformed SHA-256 digest"));

    // 3. Mismatched 64-char hex SHA-256 on artwork is rejected
    begin_idb_migration(
        &mut conn,
        &MigrationBeginRequest {
            migration_id: "mig-sha".into(),
            expected_tracks: 0,
            expected_artwork: 1,
            expected_checksum: "empty".into(),
            ..Default::default()
        },
    )
    .unwrap();

    let bad_batch = MigrationBatchRequest {
        migration_id: "mig-sha".into(),
        artwork: vec![ArtworkMigrationEntryDto {
            track_id: "t1".into(),
            mime_type: "image/png".into(),
            bytes: png,
            sha256: Some("0000000000000000000000000000000000000000000000000000000000000000".into()),
        }],
        ..Default::default()
    };
    let err = write_idb_migration_batch(&mut conn, &art_dir, &bad_batch).unwrap_err();
    assert!(err.contains("SHA-256 mismatch"));
    assert_eq!(
        get_status(&mut conn).unwrap().authority,
        "recovery-required"
    );
}

#[test]
fn never_deletes_authoritative_sqlite_data_when_integrity_checks_fail() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("auth_corrupt.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();

    let t1 = make_track("t1", "Protected Track 1");
    let t2 = make_track("t2", "Protected Track 2");
    let mut temp_conn = Connection::open_in_memory().unwrap();
    configure_connection(&temp_conn).unwrap();
    apply_migrations(&mut temp_conn).unwrap();
    put_tracks(&mut temp_conn, &[t1.clone(), t2.clone()]).unwrap();
    let cs = compute_library_checksum(&temp_conn).unwrap();

    begin_idb_migration(
        &mut conn,
        &MigrationBeginRequest {
            migration_id: "mig-auth-ok".into(),
            expected_tracks: 2,
            expected_checksum: cs.clone(),
            ..Default::default()
        },
    )
    .unwrap();
    write_idb_migration_batch(
        &mut conn,
        &art_dir,
        &MigrationBatchRequest {
            migration_id: "mig-auth-ok".into(),
            tracks: vec![t1, t2],
            ..Default::default()
        },
    )
    .unwrap();
    let st = finalize_idb_migration(&mut conn, "mig-auth-ok").unwrap();
    assert_eq!(st.authority, "sqlite");
    assert_eq!(st.track_count, 2);

    // Inject a foreign key violation into the authoritative SQLite database
    conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
    conn.execute(
        "INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES ('orphan-pl', 0, 't1')",
        [],
    )
    .unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();

    // 1. get_status transitions to non-destructive recovery-required while preserving all tracks
    let corrupt_st = get_status(&mut conn).unwrap();
    assert_eq!(corrupt_st.authority, "recovery-required");
    assert!(!corrupt_st.integrity_ok);
    assert_eq!(corrupt_st.track_count, 2);
    assert!(corrupt_st
        .recovery_guidance
        .as_deref()
        .unwrap_or("")
        .contains("preserved"));

    // 2. Automatic begin_idb_migration (even with force_reimport: true or false) MUST NOT wipe the corrupted authoritative DB
    let auto_mig = begin_idb_migration(
        &mut conn,
        &MigrationBeginRequest {
            migration_id: "mig-auto-attempt".into(),
            expected_tracks: 1,
            expected_checksum: cs,
            force_reimport: false,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(auto_mig.authority, "recovery-required");
    assert!(!auto_mig.integrity_ok);
    assert_eq!(auto_mig.track_count, 2);
    assert_eq!(list_tracks(&conn).unwrap().len(), 2);

    // 3. mark_migration_failed also preserves the authoritative rows for diagnosis
    let fail_st = mark_migration_failed(&mut conn, "diagnostic check").unwrap();
    assert_eq!(fail_st.authority, "recovery-required");
    assert_eq!(fail_st.track_count, 2);
    assert_eq!(list_tracks(&conn).unwrap().len(), 2);
}

#[test]
fn force_reimport_restores_authoritative_sqlite_database_if_migration_fails_or_is_interrupted() {
    use sha2::{Digest, Sha256};

    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("force_rollback.sqlite3");
    let art_dir = dir.path().join("artwork-v1");
    let mut conn = open_and_initialize_db(&db_path).unwrap();

    let t1 = make_track("t1", "Authoritative Track 1");
    let t2 = make_track("t2", "Authoritative Track 2");
    let png = sample_png_bytes(55);
    let png_sha = format!("{:x}", Sha256::digest(&png));

    let mut temp_conn = Connection::open_in_memory().unwrap();
    configure_connection(&temp_conn).unwrap();
    apply_migrations(&mut temp_conn).unwrap();
    put_tracks(&mut temp_conn, &[t1.clone(), t2.clone()]).unwrap();
    let auth_cs = compute_library_checksum(&temp_conn).unwrap();

    // 1. Establish initial authoritative SQLite database with 2 tracks and 1 artwork
    begin_idb_migration(
        &mut conn,
        &MigrationBeginRequest {
            migration_id: "mig-init".into(),
            expected_tracks: 2,
            expected_artwork: 1,
            expected_checksum: auth_cs.clone(),
            ..Default::default()
        },
    )
    .unwrap();
    write_idb_migration_batch(
        &mut conn,
        &art_dir,
        &MigrationBatchRequest {
            migration_id: "mig-init".into(),
            tracks: vec![t1.clone(), t2.clone()],
            artwork: vec![ArtworkMigrationEntryDto {
                track_id: "t1".into(),
                mime_type: "image/png".into(),
                bytes: png.clone(),
                sha256: Some(png_sha),
            }],
            ..Default::default()
        },
    )
    .unwrap();
    let st = finalize_idb_migration(&mut conn, "mig-init").unwrap();
    assert_eq!(st.authority, "sqlite");
    assert_eq!(st.track_count, 2);
    assert_eq!(st.artwork_count, 1);

    // 2. Start explicit force_reimport that fails midway on finalize checksum/count mismatch
    begin_idb_migration(
        &mut conn,
        &MigrationBeginRequest {
            migration_id: "mig-force-fail".into(),
            expected_tracks: 5,
            expected_checksum: "wrong-checksum".into(),
            force_reimport: true,
            ..Default::default()
        },
    )
    .unwrap();
    write_idb_migration_batch(
        &mut conn,
        &art_dir,
        &MigrationBatchRequest {
            migration_id: "mig-force-fail".into(),
            tracks: vec![make_track("temp-track", "Should Be Rolled Back")],
            ..Default::default()
        },
    )
    .unwrap();

    let err = finalize_idb_migration(&mut conn, "mig-force-fail").unwrap_err();
    assert!(err.contains("count mismatch"));

    // Authoritative SQLite database must be 100% restored to 'sqlite' with original 2 tracks and artwork!
    let restored_st = get_status(&mut conn).unwrap();
    assert_eq!(restored_st.authority, "sqlite");
    assert!(restored_st.integrity_ok);
    assert_eq!(restored_st.track_count, 2);
    assert_eq!(restored_st.artwork_count, 1);
    assert!(get_track(&conn, "temp-track").unwrap().is_none());
    assert_eq!(
        get_track(&conn, "t1").unwrap().unwrap().title,
        "Authoritative Track 1"
    );
    assert!(get_artwork(&conn, &art_dir, "t1").unwrap().is_some());

    // 3. Start explicit force_reimport and simulate process crash before finalize
    begin_idb_migration(
        &mut conn,
        &MigrationBeginRequest {
            migration_id: "mig-force-crash".into(),
            expected_tracks: 1,
            expected_checksum: "crash-cs".into(),
            force_reimport: true,
            ..Default::default()
        },
    )
    .unwrap();
    drop(conn);

    // Reopening database after crash during force_reimport restores authoritative SQLite library
    let mut reopened = open_and_initialize_db(&db_path).unwrap();
    let after_crash_st = get_status(&mut reopened).unwrap();
    assert_eq!(after_crash_st.authority, "sqlite");
    assert_eq!(after_crash_st.track_count, 2);
    assert_eq!(after_crash_st.artwork_count, 1);
}
