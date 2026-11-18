use crate::artwork::{cache as art_cache, process as art_process};
use crate::lyrics::Line;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::models::{
    ArtworkMigrationEntryDto, AudioMigrationEntryDto, BrokenInfoDto, LyricOriginDto,
    LyricsCacheMetaDto, MigrationBatchRequest, MigrationBeginRequest, PersistenceStatusDto,
    PlaylistDto, PrefEntryDto, ReplaceLibraryRequest, TrackDto, TrackLyricsDto,
    MAX_AUDIO_BLOB_BYTES, MAX_BATCH_SIZE,
};
use super::schema::{
    apply_migrations, configure_connection, read_user_version, run_integrity_checks,
};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub fn open_and_initialize_db(db_path: &Path) -> Result<Connection, String> {
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create SQLite parent directory: {e}"))?;
    }
    let mut conn = Connection::open(db_path)
        .map_err(|e| format!("Failed to open SQLite database {}: {e}", db_path.display()))?;
    configure_connection(&conn)?;
    apply_migrations(&mut conn)?;
    ensure_migration_state_row(&conn)?;
    recover_interrupted_migration_on_open(&conn)?;
    Ok(conn)
}

fn ensure_migration_state_row(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO migration_state (id, authority) VALUES (1, 'indexeddb')",
        [],
    )
    .map_err(|e| format!("Failed to initialize migration_state row: {e}"))?;
    Ok(())
}

fn has_reimport_backup(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_reimport_bak_state'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .unwrap_or(0)
        > 0
}

fn is_or_was_sqlite_authoritative(conn: &Connection) -> Result<bool, String> {
    let (auth, completed_at, verified_cs): (String, Option<i64>, Option<String>) = conn
        .query_row(
            "SELECT authority, completed_at, verified_checksum FROM migration_state WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(auth == "sqlite"
        || completed_at.is_some()
        || verified_cs.is_some()
        || has_reimport_backup(conn))
}

fn save_reimport_backup_tx(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute_batch(
        r#"
        DROP TABLE IF EXISTS _reimport_bak_tracks;
        DROP TABLE IF EXISTS _reimport_bak_playlists;
        DROP TABLE IF EXISTS _reimport_bak_playlist_tracks;
        DROP TABLE IF EXISTS _reimport_bak_lyrics;
        DROP TABLE IF EXISTS _reimport_bak_lyrics_meta;
        DROP TABLE IF EXISTS _reimport_bak_prefs;
        DROP TABLE IF EXISTS _reimport_bak_artwork_refs;
        DROP TABLE IF EXISTS _reimport_bak_audio_blobs;
        DROP TABLE IF EXISTS _reimport_bak_state;

        CREATE TABLE _reimport_bak_tracks AS SELECT * FROM tracks;
        CREATE TABLE _reimport_bak_playlists AS SELECT * FROM playlists;
        CREATE TABLE _reimport_bak_playlist_tracks AS SELECT * FROM playlist_tracks;
        CREATE TABLE _reimport_bak_lyrics AS SELECT * FROM lyrics;
        CREATE TABLE _reimport_bak_lyrics_meta AS SELECT * FROM lyrics_meta;
        CREATE TABLE _reimport_bak_prefs AS SELECT * FROM prefs;
        CREATE TABLE _reimport_bak_artwork_refs AS SELECT * FROM artwork_refs;
        CREATE TABLE _reimport_bak_audio_blobs AS SELECT * FROM audio_blobs;
        CREATE TABLE _reimport_bak_state AS
            SELECT authority, migration_id, started_at, completed_at, expected_tracks,
                   expected_playlists, expected_lyrics, expected_lyrics_meta, expected_prefs,
                   expected_artwork, expected_audio, expected_checksum, verified_checksum
            FROM migration_state WHERE id = 1;
        "#,
    )
    .map_err(|e| format!("Failed to save authoritative re-import backup snapshot: {e}"))
}

fn drop_reimport_backup_conn(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        DROP TABLE IF EXISTS _reimport_bak_tracks;
        DROP TABLE IF EXISTS _reimport_bak_playlists;
        DROP TABLE IF EXISTS _reimport_bak_playlist_tracks;
        DROP TABLE IF EXISTS _reimport_bak_lyrics;
        DROP TABLE IF EXISTS _reimport_bak_lyrics_meta;
        DROP TABLE IF EXISTS _reimport_bak_prefs;
        DROP TABLE IF EXISTS _reimport_bak_artwork_refs;
        DROP TABLE IF EXISTS _reimport_bak_audio_blobs;
        DROP TABLE IF EXISTS _reimport_bak_state;
        "#,
    )
    .map_err(|e| format!("Failed to drop re-import backup snapshot: {e}"))
}

fn restore_reimport_backup_conn(conn: &Connection, reason: &str) -> Result<(), String> {
    if !has_reimport_backup(conn) {
        return Ok(());
    }
    let _ = conn.pragma_update(None, "foreign_keys", "OFF");
    let res = conn.execute_batch(
        r#"
        BEGIN IMMEDIATE;
        DELETE FROM playlist_tracks;
        DELETE FROM playlists;
        DELETE FROM lyrics;
        DELETE FROM lyrics_meta;
        DELETE FROM artwork_refs;
        DELETE FROM audio_blobs;
        DELETE FROM tracks;
        DELETE FROM prefs;

        INSERT INTO tracks SELECT * FROM _reimport_bak_tracks;
        INSERT INTO playlists SELECT * FROM _reimport_bak_playlists;
        INSERT INTO playlist_tracks SELECT * FROM _reimport_bak_playlist_tracks;
        INSERT INTO lyrics SELECT * FROM _reimport_bak_lyrics;
        INSERT INTO lyrics_meta SELECT * FROM _reimport_bak_lyrics_meta;
        INSERT INTO prefs SELECT * FROM _reimport_bak_prefs;
        INSERT INTO artwork_refs SELECT * FROM _reimport_bak_artwork_refs;
        INSERT INTO audio_blobs SELECT * FROM _reimport_bak_audio_blobs;

        UPDATE migration_state SET
            authority = (SELECT authority FROM _reimport_bak_state LIMIT 1),
            migration_id = (SELECT migration_id FROM _reimport_bak_state LIMIT 1),
            started_at = (SELECT started_at FROM _reimport_bak_state LIMIT 1),
            completed_at = (SELECT completed_at FROM _reimport_bak_state LIMIT 1),
            expected_tracks = (SELECT expected_tracks FROM _reimport_bak_state LIMIT 1),
            expected_playlists = (SELECT expected_playlists FROM _reimport_bak_state LIMIT 1),
            expected_lyrics = (SELECT expected_lyrics FROM _reimport_bak_state LIMIT 1),
            expected_lyrics_meta = (SELECT expected_lyrics_meta FROM _reimport_bak_state LIMIT 1),
            expected_prefs = (SELECT expected_prefs FROM _reimport_bak_state LIMIT 1),
            expected_artwork = (SELECT expected_artwork FROM _reimport_bak_state LIMIT 1),
            expected_audio = (SELECT expected_audio FROM _reimport_bak_state LIMIT 1),
            expected_checksum = (SELECT expected_checksum FROM _reimport_bak_state LIMIT 1),
            verified_checksum = (SELECT verified_checksum FROM _reimport_bak_state LIMIT 1),
            last_error = NULL
        WHERE id = 1;

        DROP TABLE IF EXISTS _reimport_bak_tracks;
        DROP TABLE IF EXISTS _reimport_bak_playlists;
        DROP TABLE IF EXISTS _reimport_bak_playlist_tracks;
        DROP TABLE IF EXISTS _reimport_bak_lyrics;
        DROP TABLE IF EXISTS _reimport_bak_lyrics_meta;
        DROP TABLE IF EXISTS _reimport_bak_prefs;
        DROP TABLE IF EXISTS _reimport_bak_artwork_refs;
        DROP TABLE IF EXISTS _reimport_bak_audio_blobs;
        DROP TABLE IF EXISTS _reimport_bak_state;
        COMMIT;
        "#,
    );
    let _ = conn.pragma_update(None, "foreign_keys", "ON");
    res.map_err(|e| {
        let _ = conn.execute_batch("ROLLBACK;");
        format!("Failed to restore authoritative re-import backup snapshot: {e}")
    })?;
    let _ = conn.execute(
        "UPDATE migration_state SET last_error = ?1 WHERE id = 1",
        params![reason],
    );
    Ok(())
}

/// If a previous process exited while `authority = 'migrating'`, either restore
/// the authoritative SQLite snapshot (if an explicit `force_reimport` was interrupted)
/// or transition to `'recovery-required'` on fresh connection open so an incomplete
/// SQLite database is never treated as ready.
fn recover_interrupted_migration_on_open(conn: &Connection) -> Result<(), String> {
    let authority: String = conn
        .query_row(
            "SELECT authority FROM migration_state WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| format!("Failed to read migration_state authority: {e}"))?;
    if authority == "migrating" {
        if has_reimport_backup(conn) {
            restore_reimport_backup_conn(
                conn,
                "Previous forced re-import was interrupted before completion; restored authoritative SQLite library.",
            )?;
        } else {
            conn.execute(
                "UPDATE migration_state SET authority = 'recovery-required', last_error = COALESCE(last_error, 'Previous IndexedDB to SQLite migration was interrupted before completion.') WHERE id = 1",
                [],
            )
            .map_err(|e| format!("Failed to mark interrupted migration on open: {e}"))?;
        }
    }
    Ok(())
}

pub fn compute_library_checksum(conn: &Connection) -> Result<String, String> {
    let mut hasher = Sha256::new();

    let mut track_stmt = conn
        .prepare("SELECT id, title, artist, album, duration_ms, file_name, file_size, is_liked, play_count FROM tracks ORDER BY id ASC")
        .map_err(|e| e.to_string())?;
    let track_rows = track_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?.unwrap_or(-1),
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for r in track_rows {
        let (id, title, artist, album, dur, fname, fsize, liked, pc) =
            r.map_err(|e| e.to_string())?;
        hasher.update(
            format!("T:{id}|{title}|{artist}|{album}|{dur}|{fname}|{fsize}|{liked}|{pc}\n")
                .as_bytes(),
        );
    }

    let mut pl_stmt = conn
        .prepare("SELECT id, name, description FROM playlists ORDER BY id ASC")
        .map_err(|e| e.to_string())?;
    let pl_rows = pl_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for r in pl_rows {
        let (pid, name, desc) = r.map_err(|e| e.to_string())?;
        let mut pt_stmt = conn
            .prepare(
                "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position ASC",
            )
            .map_err(|e| e.to_string())?;
        let tids: Vec<String> = pt_stmt
            .query_map(params![pid], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        hasher.update(format!("P:{pid}|{name}|{desc}|{}\n", tids.join(",")).as_bytes());
    }

    let mut lyr_stmt = conn
        .prepare(
            "SELECT track_id, format, offset_ms, source_name FROM lyrics ORDER BY track_id ASC",
        )
        .map_err(|e| e.to_string())?;
    let lyr_rows = lyr_stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for r in lyr_rows {
        let (tid, fmt, off, src) = r.map_err(|e| e.to_string())?;
        hasher.update(format!("L:{tid}|{fmt}|{off}|{src}\n").as_bytes());
    }

    Ok(format!("{:x}", hasher.finalize()))
}

pub fn get_status(conn: &mut Connection) -> Result<PersistenceStatusDto, String> {
    let schema_version = read_user_version(conn)?;
    let integrity_errors = run_integrity_checks(conn).unwrap_or_else(|e| vec![e]);
    let integrity_ok = integrity_errors.is_empty();

    let count_table = |table: &str| -> Result<i64, String> {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .map_err(|e| format!("Failed to count {table}: {e}"))
    };

    let track_count = count_table("tracks")?;
    let playlist_count = count_table("playlists")?;
    let lyrics_count = count_table("lyrics")?;
    let lyrics_meta_count = count_table("lyrics_meta")?;
    let prefs_count = count_table("prefs")?;
    let artwork_count = count_table("artwork_refs")?;
    let audio_count = count_table("audio_blobs")?;

    let (mut authority, migration_id, mut last_error, completed_at, verified_checksum): (
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT authority, migration_id, last_error, completed_at, verified_checksum FROM migration_state WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|e| format!("Failed to read migration_state: {e}"))?;

    let was_sqlite = authority == "sqlite"
        || completed_at.is_some()
        || verified_checksum.is_some()
        || has_reimport_backup(conn);

    if !integrity_ok {
        authority = "recovery-required".into();
        let joined = integrity_errors.join("; ");
        last_error = Some(joined.clone());
        let marker_ts = completed_at.or_else(|| if was_sqlite { Some(now_ms()) } else { None });
        let _ = conn.execute(
            "UPDATE migration_state SET authority = 'recovery-required', last_error = ?1, completed_at = COALESCE(completed_at, ?2) WHERE id = 1",
            params![joined, marker_ts],
        );
    }

    let recovery_guidance = if authority == "recovery-required" {
        if was_sqlite && !integrity_ok {
            Some(
                "SQLite integrity check failed; authoritative database has been preserved in a non-destructive recovery state for diagnosis.".into(),
            )
        } else {
            Some(
                "SQLite migration or integrity check requires recovery. Your original IndexedDB library is intact and active; retry migration to rebuild the SQLite database safely.".into(),
            )
        }
    } else {
        None
    };

    Ok(PersistenceStatusDto {
        authority,
        schema_version,
        integrity_ok,
        integrity_errors,
        track_count,
        playlist_count,
        lyrics_count,
        lyrics_meta_count,
        prefs_count,
        artwork_count,
        audio_count,
        migration_id,
        last_error,
        recovery_guidance,
    })
}

fn upsert_track_tx(tx: &Transaction<'_>, track: &TrackDto) -> Result<(), String> {
    track.validate()?;
    let broken_json = match track.broken {
        Some(ref b) => Some(serde_json::to_string(b).map_err(|e| e.to_string())?),
        None => None,
    };
    let mut statement = tx
        .prepare_cached(
            r#"
        INSERT INTO tracks (
            id, title, artist, album, track_number, album_track_count, duration_ms,
            file_name, file_size, mime_type, added_at, last_played_at, play_count,
            is_liked, availability, access_mode, fingerprint, metadata_from_filename,
            broken_json, description, updated_at, desktop_path, object_key,
            artwork_object_key, storage_provider, cloud_status, last_synced_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7,
            ?8, ?9, ?10, ?11, ?12, ?13,
            ?14, ?15, ?16, ?17, ?18,
            ?19, ?20, ?21, ?22, ?23,
            ?24, ?25, ?26, ?27
        )
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            artist = excluded.artist,
            album = excluded.album,
            track_number = excluded.track_number,
            album_track_count = excluded.album_track_count,
            duration_ms = excluded.duration_ms,
            file_name = excluded.file_name,
            file_size = excluded.file_size,
            mime_type = excluded.mime_type,
            added_at = excluded.added_at,
            last_played_at = excluded.last_played_at,
            play_count = excluded.play_count,
            is_liked = excluded.is_liked,
            availability = excluded.availability,
            access_mode = excluded.access_mode,
            fingerprint = excluded.fingerprint,
            metadata_from_filename = excluded.metadata_from_filename,
            broken_json = excluded.broken_json,
            description = excluded.description,
            updated_at = excluded.updated_at,
            desktop_path = excluded.desktop_path,
            object_key = excluded.object_key,
            artwork_object_key = excluded.artwork_object_key,
            storage_provider = excluded.storage_provider,
            cloud_status = excluded.cloud_status,
            last_synced_at = excluded.last_synced_at
        "#,
        )
        .map_err(|e| format!("Failed to prepare track upsert: {e}"))?;
    statement
        .execute(params![
            track.id,
            track.title,
            track.artist,
            track.album,
            track.track_number,
            track.album_track_count,
            track.duration_ms,
            track.file_name,
            track.file_size,
            track.mime_type,
            track.added_at,
            track.last_played_at,
            track.play_count,
            if track.is_liked { 1i64 } else { 0i64 },
            track.availability,
            track.access_mode,
            track.fingerprint,
            if track.metadata_from_filename {
                1i64
            } else {
                0i64
            },
            broken_json,
            track.description,
            track.updated_at,
            track.desktop_path,
            track.object_key,
            track.artwork_object_key,
            track.storage_provider,
            track.cloud_status,
            track.last_synced_at,
        ])
        .map_err(|e| format!("Failed to upsert track {}: {e}", track.id))?;
    Ok(())
}

fn row_to_track(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrackDto> {
    let broken_raw: Option<String> = row.get(18)?;
    let broken: Option<BrokenInfoDto> = broken_raw
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());
    Ok(TrackDto {
        id: row.get(0)?,
        title: row.get(1)?,
        artist: row.get(2)?,
        album: row.get(3)?,
        track_number: row.get(4)?,
        album_track_count: row.get(5)?,
        duration_ms: row.get(6)?,
        file_name: row.get(7)?,
        file_size: row.get(8)?,
        mime_type: row.get(9)?,
        added_at: row.get(10)?,
        last_played_at: row.get(11)?,
        play_count: row.get(12)?,
        is_liked: row.get::<_, i64>(13)? != 0,
        availability: row.get(14)?,
        access_mode: row.get(15)?,
        fingerprint: row.get(16)?,
        metadata_from_filename: row.get::<_, i64>(17)? != 0,
        broken,
        description: row.get(19)?,
        updated_at: row.get(20)?,
        desktop_path: row.get(21)?,
        object_key: row.get(22)?,
        artwork_object_key: row.get(23)?,
        storage_provider: row.get(24)?,
        cloud_status: row.get(25)?,
        last_synced_at: row.get(26)?,
    })
}

pub fn list_tracks(conn: &Connection) -> Result<Vec<TrackDto>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                id, title, artist, album, track_number, album_track_count, duration_ms,
                file_name, file_size, mime_type, added_at, last_played_at, play_count,
                is_liked, availability, access_mode, fingerprint, metadata_from_filename,
                broken_json, description, updated_at, desktop_path, object_key,
                artwork_object_key, storage_provider, cloud_status, last_synced_at
            FROM tracks
            ORDER BY rowid ASC
            "#,
        )
        .map_err(|e| format!("Failed to prepare list_tracks: {e}"))?;
    let rows = stmt
        .query_map([], row_to_track)
        .map_err(|e| format!("Failed to query tracks: {e}"))?;
    let mut tracks = Vec::new();
    for r in rows {
        tracks.push(r.map_err(|e| format!("Failed to decode track row: {e}"))?);
    }
    Ok(tracks)
}

pub fn get_track(conn: &Connection, id: &str) -> Result<Option<TrackDto>, String> {
    if id.trim().is_empty() || id.len() > 256 {
        return Err("Invalid track ID.".into());
    }
    conn.query_row(
        r#"
        SELECT
            id, title, artist, album, track_number, album_track_count, duration_ms,
            file_name, file_size, mime_type, added_at, last_played_at, play_count,
            is_liked, availability, access_mode, fingerprint, metadata_from_filename,
            broken_json, description, updated_at, desktop_path, object_key,
            artwork_object_key, storage_provider, cloud_status, last_synced_at
        FROM tracks
        WHERE id = ?1
        "#,
        params![id],
        row_to_track,
    )
    .optional()
    .map_err(|e| format!("Failed to get track {id}: {e}"))
}

pub fn put_tracks(conn: &mut Connection, tracks: &[TrackDto]) -> Result<(), String> {
    if tracks.len() > MAX_BATCH_SIZE * 10 {
        return Err("putTracks batch exceeds limit.".into());
    }
    for t in tracks {
        t.validate()?;
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for track in tracks {
        upsert_track_tx(&tx, track)?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "jpg",
    }
}

fn persistent_artwork_blobs_dir(artwork_cache_dir: &Path) -> std::path::PathBuf {
    let parent = artwork_cache_dir.parent().unwrap_or(artwork_cache_dir);
    parent.join("persistent-artwork-v1").join("blobs")
}

fn atomic_write_persistent_artwork(dir: &Path, target: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create persistent artwork directory: {e}"))?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)
        .map_err(|e| format!("Failed to create temp persistent artwork file: {e}"))?;
    temp.write_all(bytes)
        .and_then(|()| temp.as_file().sync_all())
        .map_err(|e| format!("Failed to flush persistent artwork file: {e}"))?;
    temp.persist(target)
        .map_err(|e| format!("Failed to persist artwork file: {e}"))?;
    Ok(())
}

fn remove_unreferenced_persistent_artwork_blobs(conn: &Connection, artwork_cache_dir: &Path) {
    let blobs_dir = persistent_artwork_blobs_dir(artwork_cache_dir);
    if !blobs_dir.is_dir() {
        return;
    }
    let mut referenced = HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT DISTINCT content_hash FROM artwork_refs") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for r in rows.flatten() {
                referenced.insert(r);
            }
        }
    }
    if has_reimport_backup(conn) {
        if let Ok(mut stmt) =
            conn.prepare("SELECT DISTINCT content_hash FROM _reimport_bak_artwork_refs")
        {
            if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                for r in rows.flatten() {
                    referenced.insert(r);
                }
            }
        }
    }
    if let Ok(entries) = fs::read_dir(&blobs_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let hash_prefix = fname.split('_').next().unwrap_or("");
            if hash_prefix.is_empty() || !referenced.contains(hash_prefix) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn store_artwork_in_cache_and_ref_tx(
    tx: &Transaction<'_>,
    artwork_cache_dir: &Path,
    track_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let validated = art_process::validate_and_inspect_image(bytes)?;
    let content_hash = format!("{:x}", Sha256::digest(&validated.bytes));

    // 1. Write to durable SQLite-owned persistent artwork store (never pruned by disposable cache LRU)
    let p_blobs_dir = persistent_artwork_blobs_dir(artwork_cache_dir);
    let orig_ext = ext_for_mime(&validated.mime_type);
    let p_orig = p_blobs_dir.join(format!("{content_hash}_orig.{orig_ext}"));
    if !p_orig.exists() {
        atomic_write_persistent_artwork(&p_blobs_dir, &p_orig, &validated.bytes)?;
    }
    if let Ok(thumb_500) = art_process::generate_thumbnail(&validated, 500) {
        if thumb_500.bytes != validated.bytes {
            let t500_ext = ext_for_mime(&thumb_500.mime_type);
            let p_500 = p_blobs_dir.join(format!("{content_hash}_500.{t500_ext}"));
            if !p_500.exists() {
                let _ = atomic_write_persistent_artwork(&p_blobs_dir, &p_500, &thumb_500.bytes);
            }
        }
    }

    // 2. Also warm Phase 3 disposable artwork cache for fast thumbnail serving
    let key = format!("track::{track_id}");
    let _ = art_cache::store_artwork_blob(
        artwork_cache_dir,
        &[key],
        Some(track_id),
        &validated,
        "embedded",
        art_cache::CachedArtworkRecord {
            confidence: 100,
            ..Default::default()
        },
    );

    tx.execute(
        r#"
        INSERT INTO artwork_refs (track_id, content_hash, mime_type, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(track_id) DO UPDATE SET
            content_hash = excluded.content_hash,
            mime_type = excluded.mime_type,
            updated_at = excluded.updated_at
        "#,
        params![track_id, content_hash, validated.mime_type, now_ms()],
    )
    .map_err(|e| format!("Failed to store artwork ref for {track_id}: {e}"))?;
    Ok(())
}

pub fn put_track_with_files(
    conn: &mut Connection,
    artwork_cache_dir: &Path,
    track: &TrackDto,
    artwork: Option<&ArtworkMigrationEntryDto>,
    audio: Option<&AudioMigrationEntryDto>,
) -> Result<(), String> {
    track.validate()?;
    if let Some(aud) = audio {
        if aud.bytes.len() > MAX_AUDIO_BLOB_BYTES {
            return Err("Audio blob exceeds maximum allowed size.".into());
        }
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    upsert_track_tx(&tx, track)?;
    if let Some(art) = artwork {
        if !art.bytes.is_empty() {
            store_artwork_in_cache_and_ref_tx(&tx, artwork_cache_dir, &track.id, &art.bytes)?;
        }
    }
    if let Some(aud) = audio {
        if !aud.bytes.is_empty() {
            tx.execute(
                r#"
                INSERT INTO audio_blobs (track_id, mime_type, bytes, updated_at)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(track_id) DO UPDATE SET
                    mime_type = excluded.mime_type,
                    bytes = excluded.bytes,
                    updated_at = excluded.updated_at
                "#,
                params![track.id, aud.mime_type, aud.bytes, now_ms()],
            )
            .map_err(|e| format!("Failed to store audio blob for {}: {e}", track.id))?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn delete_tracks(
    conn: &mut Connection,
    artwork_cache_dir: &Path,
    ids: &[String],
) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for id in ids {
        if id.trim().is_empty() || id.len() > 256 {
            return Err("Invalid track ID in deleteTracks.".into());
        }
        tx.execute("DELETE FROM tracks WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM artwork_refs WHERE track_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM audio_blobs WHERE track_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM lyrics WHERE track_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM lyrics_meta WHERE track_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }

    // Also clean pending-metadata-sync in prefs if present
    let pending_raw: Option<String> = tx
        .query_row(
            "SELECT payload_json FROM prefs WHERE name = 'pending-metadata-sync'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(raw) = pending_raw {
        if let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(&raw)
        {
            let id_set: HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
            let filtered: Vec<serde_json::Value> = items
                .into_iter()
                .filter(|item| {
                    item.get("trackId")
                        .and_then(|v| v.as_str())
                        .map(|tid| !id_set.contains(tid))
                        .unwrap_or(true)
                })
                .collect();
            let new_json = serde_json::to_string(&filtered).map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE prefs SET payload_json = ?1, updated_at = ?2 WHERE name = 'pending-metadata-sync'",
                params![new_json, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    let keys: Vec<String> = ids.iter().map(|id| format!("track::{id}")).collect();
    let _ = art_cache::invalidate_keys(artwork_cache_dir, &keys);
    remove_unreferenced_persistent_artwork_blobs(conn, artwork_cache_dir);
    Ok(())
}

// ---- Artwork & Audio Blobs ----

pub fn put_artwork(
    conn: &mut Connection,
    artwork_cache_dir: &Path,
    track_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if track_id.trim().is_empty() || track_id.len() > 256 {
        return Err("Invalid track ID.".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    store_artwork_in_cache_and_ref_tx(&tx, artwork_cache_dir, track_id, bytes)?;
    tx.commit().map_err(|e| e.to_string())?;
    remove_unreferenced_persistent_artwork_blobs(conn, artwork_cache_dir);
    Ok(())
}

pub fn get_artwork(
    conn: &Connection,
    artwork_cache_dir: &Path,
    track_id: &str,
) -> Result<Option<(String, Vec<u8>)>, String> {
    if track_id.trim().is_empty() || track_id.len() > 256 {
        return Err("Invalid track ID.".into());
    }
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT content_hash, mime_type FROM artwork_refs WHERE track_id = ?1",
            params![track_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((content_hash, mime_type)) = row else {
        return Ok(None);
    };

    // 1. Check durable persistent artwork store first, then disposable artwork cache blobs
    let p_blobs_dir = persistent_artwork_blobs_dir(artwork_cache_dir);
    let c_blobs_dir = artwork_cache_dir.join("blobs");
    let prefix_500 = format!("{content_hash}_500.");
    let prefix_orig = format!("{content_hash}_orig.");

    for dir in [&p_blobs_dir, &c_blobs_dir] {
        if let Ok(entries) = fs::read_dir(dir) {
            let mut orig_candidate = None;
            for entry in entries.flatten() {
                let fname = entry.file_name().to_string_lossy().into_owned();
                if fname.starts_with(&prefix_500) {
                    if let Ok(bytes) = fs::read(entry.path()) {
                        return Ok(Some((mime_type, bytes)));
                    }
                } else if fname.starts_with(&prefix_orig) {
                    orig_candidate = Some(entry.path());
                }
            }
            if let Some(orig_path) = orig_candidate {
                if let Ok(bytes) = fs::read(orig_path) {
                    return Ok(Some((mime_type, bytes)));
                }
            }
        }
    }

    Ok(None)
}

pub fn delete_artwork(
    conn: &mut Connection,
    artwork_cache_dir: &Path,
    track_id: &str,
) -> Result<(), String> {
    if track_id.trim().is_empty() || track_id.len() > 256 {
        return Err("Invalid track ID.".into());
    }
    conn.execute(
        "DELETE FROM artwork_refs WHERE track_id = ?1",
        params![track_id],
    )
    .map_err(|e| e.to_string())?;
    let _ = art_cache::invalidate_keys(artwork_cache_dir, &[format!("track::{track_id}")]);
    remove_unreferenced_persistent_artwork_blobs(conn, artwork_cache_dir);
    Ok(())
}

pub fn list_artwork_track_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT track_id FROM artwork_refs ORDER BY track_id ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut ids = Vec::new();
    for r in rows {
        ids.push(r.map_err(|e| e.to_string())?);
    }
    Ok(ids)
}

pub fn put_audio_blob(
    conn: &mut Connection,
    track_id: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if track_id.trim().is_empty() || track_id.len() > 256 {
        return Err("Invalid track ID.".into());
    }
    if bytes.len() > MAX_AUDIO_BLOB_BYTES {
        return Err("Audio blob exceeds maximum allowed size.".into());
    }
    conn.execute(
        r#"
        INSERT INTO audio_blobs (track_id, mime_type, bytes, updated_at)
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(track_id) DO UPDATE SET
            mime_type = excluded.mime_type,
            bytes = excluded.bytes,
            updated_at = excluded.updated_at
        "#,
        params![track_id, mime_type, bytes, now_ms()],
    )
    .map_err(|e| format!("Failed to store audio blob: {e}"))?;
    Ok(())
}

pub fn get_audio_blob(
    conn: &Connection,
    track_id: &str,
) -> Result<Option<(String, Vec<u8>)>, String> {
    if track_id.trim().is_empty() || track_id.len() > 256 {
        return Err("Invalid track ID.".into());
    }
    conn.query_row(
        "SELECT mime_type, bytes FROM audio_blobs WHERE track_id = ?1",
        params![track_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn delete_audio_blob(conn: &mut Connection, track_id: &str) -> Result<(), String> {
    if track_id.trim().is_empty() || track_id.len() > 256 {
        return Err("Invalid track ID.".into());
    }
    conn.execute(
        "DELETE FROM audio_blobs WHERE track_id = ?1",
        params![track_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn count_stored_audio(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM audio_blobs", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

pub fn list_audio_track_ids(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT track_id FROM audio_blobs ORDER BY track_id ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut ids = Vec::new();
    for r in rows {
        ids.push(r.map_err(|e| e.to_string())?);
    }
    Ok(ids)
}

// ---- Playlists ----

fn upsert_playlist_tx(tx: &Transaction<'_>, playlist: &PlaylistDto) -> Result<(), String> {
    playlist.validate()?;
    tx.execute(
        r#"
        INSERT INTO playlists (id, name, description, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        "#,
        params![
            playlist.id,
            playlist.name,
            playlist.description,
            playlist.created_at,
            playlist.updated_at
        ],
    )
    .map_err(|e| format!("Failed to upsert playlist {}: {e}", playlist.id))?;

    tx.execute(
        "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
        params![playlist.id],
    )
    .map_err(|e| format!("Failed to clear playlist_tracks for {}: {e}", playlist.id))?;

    let mut insert_track = tx
        .prepare(
            "INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES (?1, ?2, ?3)",
        )
        .map_err(|e| e.to_string())?;
    for (idx, track_id) in playlist.track_ids.iter().enumerate() {
        insert_track
            .execute(params![playlist.id, idx as i64, track_id])
            .map_err(|e| format!("Failed to insert playlist track at {idx}: {e}"))?;
    }
    Ok(())
}

pub fn list_playlists(conn: &Connection) -> Result<Vec<PlaylistDto>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, description, created_at, updated_at FROM playlists ORDER BY rowid ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PlaylistDto {
                id: r.get(0)?,
                name: r.get(1)?,
                description: r.get(2)?,
                track_ids: Vec::new(),
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut playlists = Vec::new();
    for r in rows {
        let mut pl = r.map_err(|e| e.to_string())?;
        let mut pt_stmt = conn
            .prepare(
                "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position ASC",
            )
            .map_err(|e| e.to_string())?;
        let tids = pt_stmt
            .query_map(params![pl.id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        for tid in tids {
            pl.track_ids.push(tid.map_err(|e| e.to_string())?);
        }
        playlists.push(pl);
    }
    Ok(playlists)
}

pub fn get_playlist(conn: &Connection, id: &str) -> Result<Option<PlaylistDto>, String> {
    if id.trim().is_empty() || id.len() > 256 {
        return Err("Invalid playlist ID.".into());
    }
    let opt = conn
        .query_row(
            "SELECT id, name, description, created_at, updated_at FROM playlists WHERE id = ?1",
            params![id],
            |r| {
                Ok(PlaylistDto {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    track_ids: Vec::new(),
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some(mut pl) = opt else {
        return Ok(None);
    };
    let mut pt_stmt = conn
        .prepare(
            "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position ASC",
        )
        .map_err(|e| e.to_string())?;
    let tids = pt_stmt
        .query_map(params![pl.id], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    for tid in tids {
        pl.track_ids.push(tid.map_err(|e| e.to_string())?);
    }
    Ok(Some(pl))
}

pub fn put_playlist(conn: &mut Connection, playlist: &PlaylistDto) -> Result<(), String> {
    playlist.validate()?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    upsert_playlist_tx(&tx, playlist)?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn delete_playlist(conn: &mut Connection, id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 256 {
        return Err("Invalid playlist ID.".into());
    }
    conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Lyrics & LyricsCacheMeta ----

fn upsert_lyrics_tx(tx: &Transaction<'_>, lyrics: &TrackLyricsDto) -> Result<(), String> {
    lyrics.validate()?;
    let lines_json = serde_json::to_string(&lyrics.lines).map_err(|e| e.to_string())?;
    let origin_json = match lyrics.origin {
        Some(ref o) => Some(serde_json::to_string(o).map_err(|e| e.to_string())?),
        None => None,
    };
    tx.execute(
        r#"
        INSERT INTO lyrics (
            track_id, format, lines_json, offset_ms, updated_at,
            skipped_lines, source_name, origin_json, schema_version
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(track_id) DO UPDATE SET
            format = excluded.format,
            lines_json = excluded.lines_json,
            offset_ms = excluded.offset_ms,
            updated_at = excluded.updated_at,
            skipped_lines = excluded.skipped_lines,
            source_name = excluded.source_name,
            origin_json = excluded.origin_json,
            schema_version = excluded.schema_version
        "#,
        params![
            lyrics.track_id,
            lyrics.format,
            lines_json,
            lyrics.offset_ms,
            lyrics.updated_at,
            lyrics.skipped_lines,
            lyrics.source_name,
            origin_json,
            lyrics.schema_version
        ],
    )
    .map_err(|e| format!("Failed to upsert lyrics for {}: {e}", lyrics.track_id))?;
    Ok(())
}

pub fn get_lyrics(conn: &Connection, track_id: &str) -> Result<Option<TrackLyricsDto>, String> {
    if track_id.trim().is_empty() || track_id.len() > 256 {
        return Err("Invalid track ID.".into());
    }
    let row_opt = conn
        .query_row(
            r#"
            SELECT track_id, format, lines_json, offset_ms, updated_at,
                   skipped_lines, source_name, origin_json, schema_version
            FROM lyrics WHERE track_id = ?1
            "#,
            params![track_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((
        tid,
        format,
        lines_json,
        offset_ms,
        updated_at,
        skipped_lines,
        source_name,
        origin_json,
        schema_version,
    )) = row_opt
    else {
        return Ok(None);
    };
    let lines: Vec<Line> =
        serde_json::from_str(&lines_json).map_err(|e| format!("Corrupt lyrics lines JSON: {e}"))?;
    let origin: Option<LyricOriginDto> = match origin_json {
        Some(ref s) => {
            Some(serde_json::from_str(s).map_err(|e| format!("Corrupt lyrics origin JSON: {e}"))?)
        }
        None => None,
    };
    Ok(Some(TrackLyricsDto {
        track_id: tid,
        format,
        lines,
        offset_ms,
        updated_at,
        skipped_lines,
        source_name,
        origin,
        schema_version,
    }))
}

pub fn put_lyrics(conn: &mut Connection, lyrics: &TrackLyricsDto) -> Result<(), String> {
    lyrics.validate()?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    upsert_lyrics_tx(&tx, lyrics)?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn delete_lyrics(conn: &mut Connection, track_id: &str) -> Result<(), String> {
    if track_id.trim().is_empty() || track_id.len() > 256 {
        return Err("Invalid track ID.".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM lyrics WHERE track_id = ?1", params![track_id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM lyrics_meta WHERE track_id = ?1",
        params![track_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn upsert_lyrics_meta_tx(tx: &Transaction<'_>, meta: &LyricsCacheMetaDto) -> Result<(), String> {
    meta.validate()?;
    tx.execute(
        r#"
        INSERT INTO lyrics_meta (
            track_id, status, checked_at, record_id, schema_version, discovery_identity
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(track_id) DO UPDATE SET
            status = excluded.status,
            checked_at = excluded.checked_at,
            record_id = excluded.record_id,
            schema_version = excluded.schema_version,
            discovery_identity = excluded.discovery_identity
        "#,
        params![
            meta.track_id,
            meta.status,
            meta.checked_at,
            meta.record_id,
            meta.schema_version,
            meta.discovery_identity
        ],
    )
    .map_err(|e| format!("Failed to upsert lyrics_meta for {}: {e}", meta.track_id))?;
    Ok(())
}

pub fn get_lyrics_cache_meta(
    conn: &Connection,
    track_id: &str,
) -> Result<Option<LyricsCacheMetaDto>, String> {
    if track_id.trim().is_empty() || track_id.len() > 256 {
        return Err("Invalid track ID.".into());
    }
    conn.query_row(
        r#"
        SELECT track_id, status, checked_at, record_id, schema_version, discovery_identity
        FROM lyrics_meta WHERE track_id = ?1
        "#,
        params![track_id],
        |r| {
            Ok(LyricsCacheMetaDto {
                track_id: r.get(0)?,
                status: r.get(1)?,
                checked_at: r.get(2)?,
                record_id: r.get(3)?,
                schema_version: r.get(4)?,
                discovery_identity: r.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn put_lyrics_cache_meta(
    conn: &mut Connection,
    meta: &LyricsCacheMetaDto,
) -> Result<(), String> {
    meta.validate()?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    upsert_lyrics_meta_tx(&tx, meta)?;
    tx.commit().map_err(|e| e.to_string())
}

// ---- Preferences & Prefs store rows ----

fn upsert_pref_tx(tx: &Transaction<'_>, entry: &PrefEntryDto) -> Result<(), String> {
    entry.validate()?;
    let payload_json = serde_json::to_string(&entry.payload).map_err(|e| e.to_string())?;
    tx.execute(
        r#"
        INSERT INTO prefs (name, payload_json, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(name) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        "#,
        params![entry.name, payload_json, now_ms()],
    )
    .map_err(|e| format!("Failed to upsert pref {}: {e}", entry.name))?;
    Ok(())
}

pub fn get_pref_json(conn: &Connection, name: &str) -> Result<Option<serde_json::Value>, String> {
    if name.trim().is_empty() || name.len() > 128 {
        return Err("Invalid preference key name.".into());
    }
    let raw: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM prefs WHERE name = ?1",
            params![name],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match raw {
        Some(s) => {
            let val = serde_json::from_str(&s)
                .map_err(|e| format!("Corrupt preference JSON for {name}: {e}"))?;
            Ok(Some(val))
        }
        None => Ok(None),
    }
}

pub fn put_pref_json(
    conn: &mut Connection,
    name: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let entry = PrefEntryDto {
        name: name.to_string(),
        payload: payload.clone(),
    };
    entry.validate()?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    upsert_pref_tx(&tx, &entry)?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn delete_pref(conn: &mut Connection, name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.len() > 128 {
        return Err("Invalid preference key name.".into());
    }
    conn.execute("DELETE FROM prefs WHERE name = ?1", params![name])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Maintenance & Backup Replace ----

pub fn clear_library(conn: &mut Connection, artwork_cache_dir: &Path) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(
        r#"
        DELETE FROM playlist_tracks;
        DELETE FROM playlists;
        DELETE FROM lyrics;
        DELETE FROM lyrics_meta;
        DELETE FROM artwork_refs;
        DELETE FROM audio_blobs;
        DELETE FROM tracks;
        "#,
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let _ = art_cache::clear_all_cache(artwork_cache_dir);
    remove_unreferenced_persistent_artwork_blobs(conn, artwork_cache_dir);
    Ok(())
}

pub fn clear_all_data(conn: &mut Connection, artwork_cache_dir: &Path) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(
        r#"
        DELETE FROM playlist_tracks;
        DELETE FROM playlists;
        DELETE FROM lyrics;
        DELETE FROM lyrics_meta;
        DELETE FROM artwork_refs;
        DELETE FROM audio_blobs;
        DELETE FROM tracks;
        DELETE FROM prefs;
        "#,
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let _ = art_cache::clear_all_cache(artwork_cache_dir);
    remove_unreferenced_persistent_artwork_blobs(conn, artwork_cache_dir);
    Ok(())
}

pub fn replace_library(
    conn: &mut Connection,
    artwork_cache_dir: &Path,
    request: &ReplaceLibraryRequest,
) -> Result<(), String> {
    request.validate()?;
    let surviving_ids: HashSet<&str> = request.tracks.iter().map(|t| t.id.as_str()).collect();

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // Find dropped artwork and audio track IDs before deleting
    let mut dropped_artwork_ids = Vec::new();
    {
        let mut stmt = tx
            .prepare("SELECT track_id FROM artwork_refs")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for r in rows {
            let tid = r.map_err(|e| e.to_string())?;
            if !surviving_ids.contains(tid.as_str()) {
                dropped_artwork_ids.push(tid);
            }
        }
    }

    let mut dropped_audio_ids = Vec::new();
    {
        let mut stmt = tx
            .prepare("SELECT track_id FROM audio_blobs")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for r in rows {
            let tid = r.map_err(|e| e.to_string())?;
            if !surviving_ids.contains(tid.as_str()) {
                dropped_audio_ids.push(tid);
            }
        }
    }

    tx.execute_batch(
        r#"
        DELETE FROM playlist_tracks;
        DELETE FROM playlists;
        DELETE FROM lyrics;
        DELETE FROM lyrics_meta;
        DELETE FROM tracks;
        "#,
    )
    .map_err(|e| e.to_string())?;

    for track in &request.tracks {
        upsert_track_tx(&tx, track)?;
    }
    for playlist in &request.playlists {
        upsert_playlist_tx(&tx, playlist)?;
    }
    for lyrics in &request.lyrics {
        upsert_lyrics_tx(&tx, lyrics)?;
    }
    if let Some(ref prefs_val) = request.preferences {
        upsert_pref_tx(
            &tx,
            &PrefEntryDto {
                name: "app".into(),
                payload: prefs_val.clone(),
            },
        )?;
    }

    for tid in &dropped_artwork_ids {
        tx.execute("DELETE FROM artwork_refs WHERE track_id = ?1", params![tid])
            .map_err(|e| e.to_string())?;
    }
    for tid in &dropped_audio_ids {
        tx.execute("DELETE FROM audio_blobs WHERE track_id = ?1", params![tid])
            .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;

    if !dropped_artwork_ids.is_empty() {
        let keys: Vec<String> = dropped_artwork_ids
            .into_iter()
            .map(|id| format!("track::{id}"))
            .collect();
        let _ = art_cache::invalidate_keys(artwork_cache_dir, &keys);
        remove_unreferenced_persistent_artwork_blobs(conn, artwork_cache_dir);
    }

    Ok(())
}

// ---- IndexedDB -> SQLite Migration Lifecycle ----

pub fn begin_idb_migration(
    conn: &mut Connection,
    req: &MigrationBeginRequest,
) -> Result<PersistenceStatusDto, String> {
    req.validate()?;
    ensure_migration_state_row(conn)?;

    if has_reimport_backup(conn) {
        restore_reimport_backup_conn(
            conn,
            "Restored previous authoritative SQLite library before starting new migration.",
        )?;
    }

    let was_sqlite = is_or_was_sqlite_authoritative(conn)?;
    let status = get_status(conn)?;

    // P0 Data Integrity Guard:
    // 1. If SQLite is or was authoritative and integrity checks fail, NEVER delete or reset
    //    existing SQLite data; keep it in non-destructive 'recovery-required' state for diagnosis.
    // 2. If SQLite is authoritative and healthy, never overwrite it during automatic migration
    //    unless `force_reimport` is explicitly requested.
    if was_sqlite && (!status.integrity_ok || !req.force_reimport) {
        return Ok(status);
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    if was_sqlite && req.force_reimport {
        save_reimport_backup_tx(&tx)?;
    }
    tx.execute_batch(
        r#"
        DELETE FROM playlist_tracks;
        DELETE FROM playlists;
        DELETE FROM lyrics;
        DELETE FROM lyrics_meta;
        DELETE FROM artwork_refs;
        DELETE FROM audio_blobs;
        DELETE FROM tracks;
        DELETE FROM prefs;
        "#,
    )
    .map_err(|e| format!("Failed to reset tables for migration: {e}"))?;

    tx.execute(
        r#"
        UPDATE migration_state SET
            authority = 'migrating',
            migration_id = ?1,
            started_at = ?2,
            completed_at = NULL,
            expected_tracks = ?3,
            expected_playlists = ?4,
            expected_lyrics = ?5,
            expected_lyrics_meta = ?6,
            expected_prefs = ?7,
            expected_artwork = ?8,
            expected_audio = ?9,
            expected_checksum = ?10,
            verified_checksum = NULL,
            last_error = NULL
        WHERE id = 1
        "#,
        params![
            req.migration_id,
            now_ms(),
            req.expected_tracks,
            req.expected_playlists,
            req.expected_lyrics,
            req.expected_lyrics_meta,
            req.expected_prefs,
            req.expected_artwork,
            req.expected_audio,
            req.expected_checksum,
        ],
    )
    .map_err(|e| format!("Failed to update migration_state: {e}"))?;

    tx.commit().map_err(|e| e.to_string())?;
    get_status(conn)
}

pub fn write_idb_migration_batch(
    conn: &mut Connection,
    artwork_cache_dir: &Path,
    batch: &MigrationBatchRequest,
) -> Result<(), String> {
    let (authority, active_id): (String, Option<String>) = conn
        .query_row(
            "SELECT authority, migration_id FROM migration_state WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    if authority != "migrating" || active_id.as_deref() != Some(batch.migration_id.as_str()) {
        return Err("No active migration matches the supplied migrationId.".to_string());
    }

    if let Err(validation_err) = batch.validate() {
        let _ = mark_migration_failed(conn, &validation_err);
        remove_unreferenced_persistent_artwork_blobs(conn, artwork_cache_dir);
        return Err(validation_err);
    }

    let res = (|| -> Result<(), String> {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for track in &batch.tracks {
            upsert_track_tx(&tx, track)?;
        }
        for playlist in &batch.playlists {
            upsert_playlist_tx(&tx, playlist)?;
        }
        for lyrics in &batch.lyrics {
            upsert_lyrics_tx(&tx, lyrics)?;
        }
        for meta in &batch.lyrics_meta {
            upsert_lyrics_meta_tx(&tx, meta)?;
        }
        for pref in &batch.prefs {
            upsert_pref_tx(&tx, pref)?;
        }
        for art in &batch.artwork {
            if !art.bytes.is_empty() {
                store_artwork_in_cache_and_ref_tx(
                    &tx,
                    artwork_cache_dir,
                    &art.track_id,
                    &art.bytes,
                )?;
            }
        }
        for aud in &batch.audio {
            if !aud.bytes.is_empty() {
                tx.execute(
                    r#"
                    INSERT INTO audio_blobs (track_id, mime_type, bytes, updated_at)
                    VALUES (?1, ?2, ?3, ?4)
                    ON CONFLICT(track_id) DO UPDATE SET
                        mime_type = excluded.mime_type,
                        bytes = excluded.bytes,
                        updated_at = excluded.updated_at
                    "#,
                    params![aud.track_id, aud.mime_type, aud.bytes, now_ms()],
                )
                .map_err(|e| format!("Failed to migrate audio blob for {}: {e}", aud.track_id))?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    })();

    if let Err(ref err) = res {
        let _ = mark_migration_failed(conn, err);
        remove_unreferenced_persistent_artwork_blobs(conn, artwork_cache_dir);
    }
    res
}

pub fn mark_migration_failed(
    conn: &mut Connection,
    reason: &str,
) -> Result<PersistenceStatusDto, String> {
    if has_reimport_backup(conn) {
        restore_reimport_backup_conn(conn, reason)?;
        return get_status(conn);
    }

    if is_or_was_sqlite_authoritative(conn)? {
        let _ = conn.execute(
            "UPDATE migration_state SET last_error = ?1 WHERE id = 1",
            params![reason],
        );
        return get_status(conn);
    }

    let _ = conn.execute_batch(
        r#"
        DELETE FROM playlist_tracks;
        DELETE FROM playlists;
        DELETE FROM lyrics;
        DELETE FROM lyrics_meta;
        DELETE FROM artwork_refs;
        DELETE FROM audio_blobs;
        DELETE FROM tracks;
        DELETE FROM prefs;
        "#,
    );
    conn.execute(
        r#"
        UPDATE migration_state SET
            authority = 'recovery-required',
            last_error = ?1,
            verified_checksum = NULL
        WHERE id = 1
        "#,
        params![reason],
    )
    .map_err(|e| e.to_string())?;
    get_status(conn)
}

struct MigrationExpectations {
    authority: String,
    active_id: Option<String>,
    exp_tracks: i64,
    exp_playlists: i64,
    exp_lyrics: i64,
    exp_meta: i64,
    exp_prefs: i64,
    exp_art: i64,
    exp_aud: i64,
    exp_checksum: Option<String>,
}

pub fn finalize_idb_migration(
    conn: &mut Connection,
    migration_id: &str,
) -> Result<PersistenceStatusDto, String> {
    let row = conn
        .query_row(
            r#"
            SELECT
                authority, migration_id,
                expected_tracks, expected_playlists, expected_lyrics,
                expected_lyrics_meta, expected_prefs, expected_artwork, expected_audio,
                expected_checksum
            FROM migration_state WHERE id = 1
            "#,
            [],
            |r| {
                Ok(MigrationExpectations {
                    authority: r.get(0)?,
                    active_id: r.get(1)?,
                    exp_tracks: r.get(2)?,
                    exp_playlists: r.get(3)?,
                    exp_lyrics: r.get(4)?,
                    exp_meta: r.get(5)?,
                    exp_prefs: r.get(6)?,
                    exp_art: r.get(7)?,
                    exp_aud: r.get(8)?,
                    exp_checksum: r.get(9)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    let MigrationExpectations {
        authority,
        active_id,
        exp_tracks,
        exp_playlists,
        exp_lyrics,
        exp_meta,
        exp_prefs,
        exp_art,
        exp_aud,
        exp_checksum,
    } = row;

    if authority == "sqlite" && active_id.as_deref() == Some(migration_id) {
        return get_status(conn);
    }

    if authority != "migrating" || active_id.as_deref() != Some(migration_id) {
        let err = "Cannot finalize migration: migration is not active or ID mismatch.".to_string();
        let _ = mark_migration_failed(conn, &err);
        return Err(err);
    }

    let integrity_errors = run_integrity_checks(conn)?;
    if !integrity_errors.is_empty() {
        let err = format!(
            "SQLite integrity check failed during migration finalization: {}",
            integrity_errors.join("; ")
        );
        let _ = mark_migration_failed(conn, &err);
        return Err(err);
    }

    let count_table = |table: &str| -> Result<i64, String> {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .map_err(|e| e.to_string())
    };

    let act_tracks = count_table("tracks")?;
    let act_playlists = count_table("playlists")?;
    let act_lyrics = count_table("lyrics")?;
    let act_meta = count_table("lyrics_meta")?;
    let act_prefs = count_table("prefs")?;
    let act_art = count_table("artwork_refs")?;
    let act_aud = count_table("audio_blobs")?;

    if act_tracks != exp_tracks
        || act_playlists != exp_playlists
        || act_lyrics != exp_lyrics
        || act_meta != exp_meta
        || act_prefs != exp_prefs
        || act_art != exp_art
        || act_aud != exp_aud
    {
        let err = format!(
            "Migration record count mismatch (tracks {act_tracks}/{exp_tracks}, playlists {act_playlists}/{exp_playlists}, lyrics {act_lyrics}/{exp_lyrics}, meta {act_meta}/{exp_meta}, prefs {act_prefs}/{exp_prefs}, artwork {act_art}/{exp_art}, audio {act_aud}/{exp_aud})."
        );
        let _ = mark_migration_failed(conn, &err);
        return Err(err);
    }

    let actual_checksum = compute_library_checksum(conn)?;
    if let Some(expected_cs) = exp_checksum {
        if actual_checksum != expected_cs {
            let err = format!(
                "Migration checksum verification failed (expected {expected_cs}, actual {actual_checksum})."
            );
            let _ = mark_migration_failed(conn, &err);
            return Err(err);
        }
    }

    drop_reimport_backup_conn(conn)?;

    conn.execute(
        r#"
        UPDATE migration_state SET
            authority = 'sqlite',
            completed_at = ?1,
            verified_checksum = ?2,
            last_error = NULL
        WHERE id = 1
        "#,
        params![now_ms(), actual_checksum],
    )
    .map_err(|e| e.to_string())?;

    get_status(conn)
}
