use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub mod models;
pub mod repository;
pub mod schema;

#[cfg(test)]
mod tests;

use models::{
    ArtworkMigrationEntryDto, AudioMigrationEntryDto, LyricsCacheMetaDto, MigrationBatchRequest,
    MigrationBeginRequest, PersistenceStatusDto, PlaylistDto, ReplaceLibraryRequest, TrackDto,
    TrackLyricsDto,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryBlobDto {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Default)]
pub struct PersistenceEngine {
    conn: Arc<Mutex<Option<(PathBuf, Connection)>>>,
}

impl PersistenceEngine {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            conn: Arc::new(Mutex::new(None)),
        })
    }

    pub async fn with_conn<F, R>(&self, db_path: PathBuf, f: F) -> Result<R, String>
    where
        F: FnOnce(&mut Connection) -> Result<R, String> + Send + 'static,
        R: Send + 'static,
    {
        let conn_arc = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn_arc
                .lock()
                .map_err(|_| "SQLite connection lock poisoned.".to_string())?;
            let needs_open = match guard.as_ref() {
                Some((open_path, _)) => open_path != &db_path,
                None => true,
            };
            if needs_open {
                let opened = repository::open_and_initialize_db(&db_path)?;
                *guard = Some((db_path, opened));
            }
            let (_, conn) = guard.as_mut().expect("connection initialized");
            f(conn)
        })
        .await
        .map_err(|e| format!("SQLite task execution error: {e}"))?
    }
}

fn sqlite_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("persistence-v1")
        .join("gmusic.sqlite3"))
}

fn artwork_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("artwork-v1"))
}

#[tauri::command]
pub async fn get_desktop_persistence_status(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
) -> Result<PersistenceStatusDto, String> {
    let db_path = sqlite_db_path(&app)?;
    engine.with_conn(db_path, repository::get_status).await
}

#[tauri::command]
pub async fn begin_desktop_idb_migration(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    request: MigrationBeginRequest,
) -> Result<PersistenceStatusDto, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::begin_idb_migration(conn, &request)
        })
        .await
}

#[tauri::command]
pub async fn write_desktop_idb_migration_batch(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    batch: MigrationBatchRequest,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    let art_dir = artwork_cache_dir(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::write_idb_migration_batch(conn, &art_dir, &batch)
        })
        .await
}

#[tauri::command]
pub async fn finalize_desktop_idb_migration(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    migration_id: String,
) -> Result<PersistenceStatusDto, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::finalize_idb_migration(conn, &migration_id)
        })
        .await
}

#[tauri::command]
pub async fn fail_desktop_idb_migration(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    reason: String,
) -> Result<PersistenceStatusDto, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::mark_migration_failed(conn, &reason)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_list_tracks(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
) -> Result<Vec<TrackDto>, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, |conn| repository::list_tracks(conn))
        .await
}

#[tauri::command]
pub async fn sqlite_get_track(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    id: String,
) -> Result<Option<TrackDto>, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| repository::get_track(conn, &id))
        .await
}

#[tauri::command]
pub async fn sqlite_put_tracks(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    tracks: Vec<TrackDto>,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| repository::put_tracks(conn, &tracks))
        .await
}

#[tauri::command]
pub async fn sqlite_put_track_with_files(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    track: TrackDto,
    artwork: Option<ArtworkMigrationEntryDto>,
    audio: Option<AudioMigrationEntryDto>,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    let art_dir = artwork_cache_dir(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::put_track_with_files(
                conn,
                &art_dir,
                &track,
                artwork.as_ref(),
                audio.as_ref(),
            )
        })
        .await
}

#[tauri::command]
pub async fn sqlite_delete_tracks(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    ids: Vec<String>,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    let art_dir = artwork_cache_dir(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::delete_tracks(conn, &art_dir, &ids)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_get_artwork(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    track_id: String,
) -> Result<Option<BinaryBlobDto>, String> {
    let db_path = sqlite_db_path(&app)?;
    let art_dir = artwork_cache_dir(&app)?;
    let res = engine
        .with_conn(db_path, move |conn| {
            repository::get_artwork(conn, &art_dir, &track_id)
        })
        .await?;
    Ok(res.map(|(mime_type, bytes)| BinaryBlobDto { mime_type, bytes }))
}

#[tauri::command]
pub async fn sqlite_put_artwork(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    track_id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    let art_dir = artwork_cache_dir(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::put_artwork(conn, &art_dir, &track_id, &bytes)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_delete_artwork(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    track_id: String,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    let art_dir = artwork_cache_dir(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::delete_artwork(conn, &art_dir, &track_id)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_list_artwork_track_ids(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
) -> Result<Vec<String>, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, |conn| repository::list_artwork_track_ids(conn))
        .await
}

#[tauri::command]
pub async fn sqlite_get_audio_blob(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    track_id: String,
) -> Result<Option<BinaryBlobDto>, String> {
    let db_path = sqlite_db_path(&app)?;
    let res = engine
        .with_conn(db_path, move |conn| {
            repository::get_audio_blob(conn, &track_id)
        })
        .await?;
    Ok(res.map(|(mime_type, bytes)| BinaryBlobDto { mime_type, bytes }))
}

#[tauri::command]
pub async fn sqlite_put_audio_blob(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    track_id: String,
    mime_type: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::put_audio_blob(conn, &track_id, &mime_type, &bytes)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_delete_audio_blob(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    track_id: String,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::delete_audio_blob(conn, &track_id)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_count_stored_audio(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
) -> Result<i64, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, |conn| repository::count_stored_audio(conn))
        .await
}

#[tauri::command]
pub async fn sqlite_list_audio_track_ids(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
) -> Result<Vec<String>, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, |conn| repository::list_audio_track_ids(conn))
        .await
}

#[tauri::command]
pub async fn sqlite_list_playlists(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
) -> Result<Vec<PlaylistDto>, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, |conn| repository::list_playlists(conn))
        .await
}

#[tauri::command]
pub async fn sqlite_get_playlist(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    id: String,
) -> Result<Option<PlaylistDto>, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| repository::get_playlist(conn, &id))
        .await
}

#[tauri::command]
pub async fn sqlite_put_playlist(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    playlist: PlaylistDto,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::put_playlist(conn, &playlist)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_delete_playlist(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    id: String,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| repository::delete_playlist(conn, &id))
        .await
}

#[tauri::command]
pub async fn sqlite_get_lyrics(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    track_id: String,
) -> Result<Option<TrackLyricsDto>, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| repository::get_lyrics(conn, &track_id))
        .await
}

#[tauri::command]
pub async fn sqlite_put_lyrics(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    lyrics: TrackLyricsDto,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| repository::put_lyrics(conn, &lyrics))
        .await
}

#[tauri::command]
pub async fn sqlite_delete_lyrics(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    track_id: String,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::delete_lyrics(conn, &track_id)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_get_lyrics_cache_meta(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    track_id: String,
) -> Result<Option<LyricsCacheMetaDto>, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::get_lyrics_cache_meta(conn, &track_id)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_put_lyrics_cache_meta(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    meta: LyricsCacheMetaDto,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::put_lyrics_cache_meta(conn, &meta)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_get_pref_json(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    name: String,
) -> Result<Option<serde_json::Value>, String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| repository::get_pref_json(conn, &name))
        .await
}

#[tauri::command]
pub async fn sqlite_put_pref_json(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    name: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::put_pref_json(conn, &name, &payload)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_delete_pref(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    name: String,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    engine
        .with_conn(db_path, move |conn| repository::delete_pref(conn, &name))
        .await
}

#[tauri::command]
pub async fn sqlite_clear_library(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    let art_dir = artwork_cache_dir(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::clear_library(conn, &art_dir)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_replace_library(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
    request: ReplaceLibraryRequest,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    let art_dir = artwork_cache_dir(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::replace_library(conn, &art_dir, &request)
        })
        .await
}

#[tauri::command]
pub async fn sqlite_clear_all_data(
    app: AppHandle,
    engine: tauri::State<'_, PersistenceEngine>,
) -> Result<(), String> {
    let db_path = sqlite_db_path(&app)?;
    let art_dir = artwork_cache_dir(&app)?;
    engine
        .with_conn(db_path, move |conn| {
            repository::clear_all_data(conn, &art_dir)
        })
        .await
}
