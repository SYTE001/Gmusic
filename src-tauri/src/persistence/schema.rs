use rusqlite::Connection;

pub const CURRENT_SCHEMA_VERSION: i32 = 1;

const MIGRATION_V1_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT NOT NULL DEFAULT '',
    track_number INTEGER,
    album_track_count INTEGER,
    duration_ms INTEGER,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL,
    last_played_at INTEGER,
    play_count INTEGER NOT NULL DEFAULT 0,
    is_liked INTEGER NOT NULL DEFAULT 0,
    availability TEXT NOT NULL,
    access_mode TEXT NOT NULL,
    fingerprint TEXT,
    metadata_from_filename INTEGER NOT NULL DEFAULT 0,
    broken_json TEXT,
    description TEXT,
    updated_at INTEGER,
    desktop_path TEXT,
    object_key TEXT,
    artwork_object_key TEXT,
    storage_provider TEXT,
    cloud_status TEXT,
    last_synced_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tracks_added_at ON tracks(added_at);
CREATE INDEX IF NOT EXISTS idx_tracks_fingerprint ON tracks(fingerprint);

CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    track_id TEXT NOT NULL,
    PRIMARY KEY (playlist_id, position),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track_id ON playlist_tracks(track_id);

CREATE TABLE IF NOT EXISTS lyrics (
    track_id TEXT PRIMARY KEY NOT NULL,
    format TEXT NOT NULL,
    lines_json TEXT NOT NULL,
    offset_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    skipped_lines INTEGER NOT NULL DEFAULT 0,
    source_name TEXT NOT NULL,
    origin_json TEXT,
    schema_version INTEGER
);

CREATE TABLE IF NOT EXISTS lyrics_meta (
    track_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    record_id INTEGER,
    schema_version INTEGER NOT NULL,
    discovery_identity TEXT
);

CREATE TABLE IF NOT EXISTS prefs (
    name TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artwork_refs (
    track_id TEXT PRIMARY KEY NOT NULL,
    content_hash TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audio_blobs (
    track_id TEXT PRIMARY KEY NOT NULL,
    mime_type TEXT NOT NULL,
    bytes BLOB NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    authority TEXT NOT NULL,
    migration_id TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    expected_tracks INTEGER NOT NULL DEFAULT 0,
    expected_playlists INTEGER NOT NULL DEFAULT 0,
    expected_lyrics INTEGER NOT NULL DEFAULT 0,
    expected_lyrics_meta INTEGER NOT NULL DEFAULT 0,
    expected_prefs INTEGER NOT NULL DEFAULT 0,
    expected_artwork INTEGER NOT NULL DEFAULT 0,
    expected_audio INTEGER NOT NULL DEFAULT 0,
    expected_checksum TEXT,
    verified_checksum TEXT,
    last_error TEXT
);
"#;

pub fn configure_connection(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| format!("Failed to configure SQLite busy_timeout: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("Failed to enable SQLite foreign_keys: {e}"))?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    Ok(())
}

pub fn read_user_version(conn: &Connection) -> Result<i32, String> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| format!("Failed to read PRAGMA user_version: {e}"))
}

pub fn apply_migrations(conn: &mut Connection) -> Result<i32, String> {
    apply_migrations_up_to(conn, CURRENT_SCHEMA_VERSION, &[])
}

pub fn apply_migrations_up_to(
    conn: &mut Connection,
    target_version: i32,
    extra_steps: &[(i32, &str)],
) -> Result<i32, String> {
    let current = read_user_version(conn)?;
    if current > target_version {
        return Err(format!(
            "Database schema version {current} is newer than supported version {target_version}."
        ));
    }
    if current < 0 {
        return Err(format!(
            "Invalid negative database schema version {current}."
        ));
    }

    let mut version = current;
    if version < 1 && target_version >= 1 {
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to start migration transaction v1: {e}"))?;
        tx.execute_batch(MIGRATION_V1_SQL)
            .map_err(|e| format!("Migration v1 failed: {e}"))?;
        tx.pragma_update(None, "user_version", 1i32)
            .map_err(|e| format!("Failed to update user_version to 1: {e}"))?;
        tx.commit()
            .map_err(|e| format!("Failed to commit migration v1: {e}"))?;
        version = 1;
    }

    for &(step_version, sql) in extra_steps {
        if step_version > version && step_version <= target_version {
            let tx = conn.transaction().map_err(|e| {
                format!("Failed to start migration transaction v{step_version}: {e}")
            })?;
            tx.execute_batch(sql)
                .map_err(|e| format!("Migration v{step_version} failed: {e}"))?;
            tx.pragma_update(None, "user_version", step_version)
                .map_err(|e| format!("Failed to update user_version to {step_version}: {e}"))?;
            tx.commit()
                .map_err(|e| format!("Failed to commit migration v{step_version}: {e}"))?;
            version = step_version;
        }
    }

    Ok(version)
}

pub fn run_integrity_checks(conn: &Connection) -> Result<Vec<String>, String> {
    let mut errors = Vec::new();
    let quick: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| format!("SQLite quick_check failed: {e}"))?;
    if !quick.eq_ignore_ascii_case("ok") {
        errors.push(format!("quick_check: {quick}"));
    }

    let mut fk_stmt = conn
        .prepare("PRAGMA foreign_key_check")
        .map_err(|e| format!("Failed to prepare foreign_key_check: {e}"))?;
    let fk_rows = fk_stmt
        .query_map([], |row| {
            let table: String = row.get(0)?;
            let parent: String = row.get(2)?;
            Ok(format!(
                "foreign_key violation in {table} referencing {parent}"
            ))
        })
        .map_err(|e| format!("Failed to execute foreign_key_check: {e}"))?;

    for item in fk_rows {
        match item {
            Ok(msg) => errors.push(msg),
            Err(e) => errors.push(format!("foreign_key_check row error: {e}")),
        }
    }

    Ok(errors)
}
