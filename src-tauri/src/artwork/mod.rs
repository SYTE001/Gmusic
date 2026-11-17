use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

pub mod cache;
pub mod extract;
pub mod matching;
pub mod process;
pub mod providers;

use matching::{
    compute_query_fingerprint, get_album_artwork_cache_key, get_artwork_cache_key, ArtworkQuery,
};

const MAX_EXCLUDE_URLS: usize = 64;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeArtworkResolveRequest {
    pub track: ArtworkQuery,
    pub desktop_path: Option<String>,
    pub size: Option<String>,
    #[serde(default)]
    pub force_refresh: bool,
    #[serde(default)]
    pub offline: bool,
    #[serde(default)]
    pub exclude_urls: Vec<String>,
    #[serde(default)]
    pub download_and_cache: bool,
}

impl NativeArtworkResolveRequest {
    pub fn validate(&self) -> Result<(), String> {
        self.track.validate()?;
        if let Some(ref p) = self.desktop_path {
            if p.len() > 4096 {
                return Err("desktopPath exceeds maximum length.".into());
            }
        }
        if let Some(ref s) = self.size {
            if s.len() > 32 {
                return Err("size exceeds maximum length.".into());
            }
        }
        if self.exclude_urls.len() > MAX_EXCLUDE_URLS
            || self.exclude_urls.iter().any(|u| u.len() > 2048)
        {
            return Err("excludeUrls exceeds maximum count or URL length.".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeArtworkResult {
    pub url: Option<String>,
    pub source: String,
    pub release_group_mbid: Option<String>,
    pub release_mbid: Option<String>,
    pub confidence: u32,
    pub album: Option<String>,
    pub artist: Option<String>,
    pub transient_failure: bool,
    pub from_cache: bool,
    pub offline: bool,
    pub content_hash: Option<String>,
    pub mime_type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub cached_path: Option<String>,
    pub thumb_path_500: Option<String>,
    pub thumb_path_256: Option<String>,
    pub original_path: Option<String>,
    pub failed_http_requests: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeArtworkInvalidateRequest {
    pub track_id: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub include_album: Option<bool>,
    #[serde(default)]
    pub clear_all: bool,
}

pub fn validate_safe_audio_path(raw_path: &Path) -> Result<PathBuf, String> {
    let sym_meta = fs::symlink_metadata(raw_path)
        .map_err(|e| format!("Audio file path unavailable {}: {e}", raw_path.display()))?;
    if sym_meta.file_type().is_symlink() {
        return Err("Symlink audio paths are not permitted.".into());
    }
    if !sym_meta.is_file() {
        return Err("Audio path is not a regular file.".into());
    }
    let normalized = crate::normalize_fs_path(raw_path)?;
    if !crate::is_supported_audio_extension(&normalized) {
        return Err("Unsupported audio file extension.".into());
    }
    Ok(normalized)
}

pub fn read_cached_blob_bytes_restricted(
    cache_dir: &Path,
    raw_path: &Path,
) -> Result<Vec<u8>, String> {
    let sym_meta = fs::symlink_metadata(raw_path)
        .map_err(|e| format!("Cached artwork file not found: {e}"))?;
    if sym_meta.file_type().is_symlink() {
        return Err("Symlinks are not permitted in the artwork cache.".into());
    }
    if !sym_meta.is_file() {
        return Err("Cached artwork path is not a regular file.".into());
    }
    let file_len = sym_meta.len();
    if file_len < process::MIN_RAW_IMAGE_BYTES as u64
        || file_len > process::MAX_RAW_IMAGE_BYTES as u64
    {
        return Err("Cached artwork file size is out of allowed bounds.".into());
    }

    let blobs_dir = cache_dir.join("blobs");
    let canonical_blobs = fs::canonicalize(&blobs_dir)
        .map_err(|e| format!("Artwork blobs directory unavailable: {e}"))?;
    let canonical_target =
        fs::canonicalize(raw_path).map_err(|e| format!("Cached artwork file not found: {e}"))?;

    if !canonical_target.starts_with(&canonical_blobs)
        || canonical_target.parent() != Some(canonical_blobs.as_path())
    {
        return Err("Path is outside the desktop artwork blobs directory.".into());
    }

    let ext = canonical_target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp"
    ) {
        return Err("Unsupported cached artwork file extension.".into());
    }

    let file = fs::File::open(&canonical_target)
        .map_err(|e| format!("Failed to open cached artwork file: {e}"))?;
    let mut buf = Vec::with_capacity((file_len as usize).min(65536));
    file.take(process::MAX_RAW_IMAGE_BYTES as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read cached artwork file: {e}"))?;
    if buf.len() > process::MAX_RAW_IMAGE_BYTES {
        return Err("Cached artwork file exceeds maximum allowed byte size.".into());
    }
    Ok(buf)
}

pub fn invalidate_cache_entries(
    cache_dir: &Path,
    request: &NativeArtworkInvalidateRequest,
) -> Result<(), String> {
    if request.clear_all {
        return cache::clear_all_cache(cache_dir);
    }
    let mut keys = Vec::new();
    if let Some(tid) = request.track_id.as_deref().filter(|s| !s.trim().is_empty()) {
        keys.push(format!("track::{}", tid.trim()));
    }
    let query = ArtworkQuery {
        id: request.track_id.clone().unwrap_or_default(),
        title: request.title.clone().unwrap_or_default(),
        artist: request.artist.clone().unwrap_or_default(),
        album: request.album.clone().unwrap_or_default(),
        duration_ms: None,
    };
    let ak = get_album_artwork_cache_key(&query);
    let tk = get_artwork_cache_key(&query);
    if request.include_album.unwrap_or(true) && !ak.is_empty() {
        keys.push(ak);
    }
    if !tk.is_empty() && !keys.contains(&tk) {
        keys.push(tk);
    }
    cache::invalidate_keys(cache_dir, &keys)
}

pub struct ArtworkEngine {
    providers: providers::NativeArtworkProviders,
    flights: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}

impl ArtworkEngine {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            providers: providers::NativeArtworkProviders::new()?,
            flights: Default::default(),
        })
    }

    #[cfg(test)]
    pub fn with_test_endpoints(mb: String, caa: String, itunes: String) -> Self {
        Self {
            providers: providers::NativeArtworkProviders::with_test_endpoints(mb, caa, itunes),
            flights: Default::default(),
        }
    }

    async fn acquire_flight(&self, key: &str) -> Arc<Mutex<()>> {
        let mut flights = self.flights.lock().await;
        flights.retain(|_, lock| lock.strong_count() > 0);
        let lock = flights
            .get(key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| Arc::new(Mutex::new(())));
        flights.insert(key.to_string(), Arc::downgrade(&lock));
        lock
    }

    fn build_result_from_record(
        record: &cache::CachedArtworkRecord,
        size: &str,
        from_cache: bool,
        offline: bool,
    ) -> NativeArtworkResult {
        let size_num = match size {
            "256" => 256,
            "1200" | "full" => 1200,
            _ => 500,
        };
        let chosen_path =
            cache::blob_path_for_record(record, size_num).map(|p| p.to_string_lossy().into_owned());
        NativeArtworkResult {
            url: record.url.clone(),
            source: if from_cache && record.source != "none" && record.source != "embedded" {
                "cache".into()
            } else {
                record.source.clone()
            },
            release_group_mbid: record.release_group_mbid.clone(),
            release_mbid: record.release_mbid.clone(),
            confidence: record.confidence,
            album: record.album.clone(),
            artist: record.artist.clone(),
            transient_failure: false,
            from_cache,
            offline,
            content_hash: record.content_hash.clone(),
            mime_type: record.mime_type.clone(),
            width: record.width,
            height: record.height,
            cached_path: chosen_path,
            thumb_path_500: record.thumb_path_500.clone(),
            thumb_path_256: record.thumb_path_256.clone(),
            original_path: record.original_path.clone(),
            failed_http_requests: 0,
        }
    }

    pub async fn extract_embedded(
        &self,
        cache_dir: PathBuf,
        audio_path: PathBuf,
        track_id: Option<String>,
        size: String,
    ) -> Result<Option<NativeArtworkResult>, String> {
        let safe_audio_path = validate_safe_audio_path(&audio_path)?;
        let cdir = cache_dir.clone();
        let tid = track_id.clone();
        let record_opt = tokio::task::spawn_blocking(
            move || -> Result<Option<cache::CachedArtworkRecord>, String> {
                let Some(extracted) = extract::extract_embedded_artwork(&safe_audio_path)? else {
                    return Ok(None);
                };
                let Ok(validated) = process::validate_and_inspect_image(&extracted.bytes) else {
                    return Ok(None);
                };
                let mut keys = Vec::new();
                if let Some(id) = tid.as_deref().filter(|s| !s.is_empty()) {
                    keys.push(format!("track::{id}"));
                }
                let rec = cache::store_artwork_blob(
                    &cdir,
                    &keys,
                    tid.as_deref(),
                    &validated,
                    "embedded",
                    cache::CachedArtworkRecord {
                        confidence: 100,
                        ..Default::default()
                    },
                )?;
                Ok(Some(rec))
            },
        )
        .await
        .map_err(|e| e.to_string())??;

        Ok(record_opt.map(|rec| Self::build_result_from_record(&rec, &size, false, false)))
    }

    pub async fn resolve(
        &self,
        cache_dir: PathBuf,
        request: NativeArtworkResolveRequest,
    ) -> Result<NativeArtworkResult, String> {
        request.validate()?;
        let size = request.size.as_deref().unwrap_or("500").to_string();
        let album_key = get_album_artwork_cache_key(&request.track);
        let track_key = get_artwork_cache_key(&request.track);
        let query_fingerprint = compute_query_fingerprint(&request.track);
        let id_key = if request.track.id.trim().is_empty() {
            String::new()
        } else {
            format!("track::{}", request.track.id.trim())
        };
        let primary_key = if !album_key.is_empty() {
            album_key.clone()
        } else if !track_key.is_empty() {
            track_key.clone()
        } else {
            id_key.clone()
        };

        if primary_key.is_empty() {
            return Ok(NativeArtworkResult {
                source: "none".into(),
                offline: request.offline,
                ..Default::default()
            });
        }

        let lock = self.acquire_flight(&primary_key).await;
        let _guard = lock.lock().await;

        // 1. If desktop_path is provided and not force_refresh, try extracting embedded cover art
        if !request.force_refresh {
            if let Some(dpath) = request.desktop_path.as_deref().filter(|s| !s.is_empty()) {
                if let Ok(safe_path) = validate_safe_audio_path(Path::new(dpath)) {
                    if let Ok(Some(embedded)) = self
                        .extract_embedded(
                            cache_dir.clone(),
                            safe_path,
                            Some(request.track.id.clone()),
                            size.clone(),
                        )
                        .await
                    {
                        return Ok(embedded);
                    }
                }
            }
        }

        let lookup_keys: Vec<String> = [id_key.clone(), album_key.clone(), track_key.clone()]
            .into_iter()
            .filter(|k| !k.is_empty())
            .collect();

        // 2. Check persistent disk cache (track key -> album key -> artist::title key)
        if !request.force_refresh || request.offline {
            let cdir = cache_dir.clone();
            let allow_stale = request.offline;
            let excl = request.exclude_urls.clone();
            let qfp = query_fingerprint.clone();
            let ik = id_key.clone();
            let keys_for_lookup = lookup_keys.clone();
            let cached = tokio::task::spawn_blocking(move || {
                for k in keys_for_lookup {
                    if let Ok(Some(rec)) = cache::read_cached_artwork(&cdir, &k, allow_stale) {
                        // If track::<id> holds online artwork from old metadata before a title/artist/album edit,
                        // evict the stale track::<id> mapping so the updated metadata is resolved accurately.
                        if !ik.is_empty() && k == ik && rec.source != "embedded" {
                            if let Some(ref saved_fp) = rec.query_fingerprint {
                                if saved_fp != &qfp {
                                    let _ = cache::invalidate_keys(&cdir, std::slice::from_ref(&k));
                                    continue;
                                }
                            }
                        }
                        if let Some(u) = rec.url.as_deref() {
                            if excl.iter().any(|e| e == u) {
                                continue;
                            }
                        }
                        return Some(rec);
                    }
                }
                None
            })
            .await
            .map_err(|e| e.to_string())?;

            if let Some(rec) = cached {
                return Ok(Self::build_result_from_record(
                    &rec,
                    &size,
                    true,
                    request.offline,
                ));
            }
        } else if request.force_refresh {
            // Explicit force refresh: evict existing index keys before re-querying providers
            let cdir = cache_dir.clone();
            let keys_to_evict = lookup_keys.clone();
            let _ =
                tokio::task::spawn_blocking(move || cache::invalidate_keys(&cdir, &keys_to_evict))
                    .await;
        }

        if request.offline {
            return Ok(NativeArtworkResult {
                source: "none".into(),
                offline: true,
                ..Default::default()
            });
        }

        let mut keys_to_store = Vec::new();
        for k in [&id_key, &album_key, &track_key] {
            if !k.is_empty() && !keys_to_store.contains(k) {
                keys_to_store.push(k.clone());
            }
        }

        // 3. Query online providers (with 1 automatic fallback retry if image download/decode fails)
        let mut active_excludes = request.exclude_urls.clone();
        let mut total_failed_http = 0u32;
        let mut saw_transient = false;
        let mut last_rg_mbid: Option<String> = None;

        for attempt in 0..2 {
            let discovery = self
                .providers
                .discover(&request.track, &size, &active_excludes)
                .await;
            total_failed_http += discovery.failed_http_requests;
            saw_transient |= discovery.transient_failure;
            if discovery.release_group_mbid.is_some() {
                last_rg_mbid = discovery.release_group_mbid.clone();
            }

            let Some(remote_url) = discovery.url.clone() else {
                break;
            };

            if !request.download_and_cache {
                return Ok(NativeArtworkResult {
                    url: Some(remote_url),
                    source: discovery.source,
                    release_group_mbid: discovery.release_group_mbid,
                    release_mbid: discovery.release_mbid,
                    confidence: discovery.confidence,
                    album: discovery.album,
                    artist: discovery.artist,
                    transient_failure: false,
                    from_cache: false,
                    offline: false,
                    failed_http_requests: total_failed_http,
                    ..Default::default()
                });
            }

            match self.providers.download_image(&remote_url).await {
                Ok(raw_bytes) => {
                    let cdir = cache_dir.clone();
                    let keys = keys_to_store.clone();
                    let tid = request.track.id.clone();
                    let src = discovery.source.clone();
                    let url_clone = remote_url.clone();
                    let rg_mbid = discovery.release_group_mbid.clone();
                    let rel_mbid = discovery.release_mbid.clone();
                    let conf = discovery.confidence;
                    let alb = discovery.album.clone();
                    let art = discovery.artist.clone();
                    let qfp = query_fingerprint.clone();

                    let stored = tokio::task::spawn_blocking(move || {
                        let validated = process::validate_and_inspect_image(&raw_bytes)?;
                        cache::store_artwork_blob(
                            &cdir,
                            &keys,
                            if tid.is_empty() { None } else { Some(&tid) },
                            &validated,
                            &src,
                            cache::CachedArtworkRecord {
                                url: Some(url_clone),
                                release_group_mbid: rg_mbid,
                                release_mbid: rel_mbid,
                                confidence: conf,
                                album: alb,
                                artist: art,
                                query_fingerprint: Some(qfp),
                                ..Default::default()
                            },
                        )
                    })
                    .await
                    .map_err(|e| e.to_string())?;

                    if let Ok(rec) = stored {
                        let mut res = Self::build_result_from_record(&rec, &size, false, false);
                        res.source = discovery.source;
                        res.failed_http_requests = total_failed_http;
                        return Ok(res);
                    }
                }
                Err(_) => {
                    total_failed_http += 1;
                    saw_transient = true;
                }
            }

            // Image download or decode failed: exclude broken URL and retry provider discovery once
            if attempt == 0 && active_excludes.len() < MAX_EXCLUDE_URLS {
                active_excludes.push(remote_url);
            } else {
                break;
            }
        }

        // Confirmed negative lookup: cache for 24h unless transient failure occurred
        if !saw_transient {
            let cdir = cache_dir.clone();
            let keys = keys_to_store;
            let rg_mbid = last_rg_mbid.clone();
            let qfp = query_fingerprint;
            let _ = tokio::task::spawn_blocking(move || {
                cache::store_negative_record(
                    &cdir,
                    &keys,
                    cache::CachedArtworkRecord {
                        release_group_mbid: rg_mbid,
                        query_fingerprint: Some(qfp),
                        ..Default::default()
                    },
                )
            })
            .await;
        }

        Ok(NativeArtworkResult {
            url: None,
            source: "none".into(),
            release_group_mbid: last_rg_mbid,
            release_mbid: None,
            confidence: 0,
            album: None,
            artist: None,
            transient_failure: saw_transient,
            from_cache: false,
            offline: false,
            failed_http_requests: total_failed_http,
            ..Default::default()
        })
    }

    pub async fn cache_remote_image(
        &self,
        cache_dir: PathBuf,
        track: ArtworkQuery,
        remote_url: String,
        source: String,
        size: String,
    ) -> Result<Option<NativeArtworkResult>, String> {
        track.validate()?;
        if remote_url.len() > 2048 {
            return Err("Artwork URL exceeds maximum length.".into());
        }
        let raw_bytes = match self.providers.download_image(&remote_url).await {
            Ok(b) => b,
            Err(_) => return Ok(None),
        };
        let album_key = get_album_artwork_cache_key(&track);
        let track_key = get_artwork_cache_key(&track);
        let query_fingerprint = compute_query_fingerprint(&track);
        let id_key = if track.id.trim().is_empty() {
            String::new()
        } else {
            format!("track::{}", track.id.trim())
        };
        let mut keys = Vec::new();
        for k in [&id_key, &album_key, &track_key] {
            if !k.is_empty() && !keys.contains(k) {
                keys.push(k.clone());
            }
        }
        let tid = track.id.clone();
        let stored = tokio::task::spawn_blocking(
            move || -> Result<Option<cache::CachedArtworkRecord>, String> {
                let Ok(validated) = process::validate_and_inspect_image(&raw_bytes) else {
                    return Ok(None);
                };
                let rec = cache::store_artwork_blob(
                    &cache_dir,
                    &keys,
                    if tid.is_empty() { None } else { Some(&tid) },
                    &validated,
                    &source,
                    cache::CachedArtworkRecord {
                        url: Some(remote_url),
                        confidence: 85,
                        album: if track.album.is_empty() {
                            None
                        } else {
                            Some(track.album)
                        },
                        artist: if track.artist.is_empty() {
                            None
                        } else {
                            Some(track.artist)
                        },
                        query_fingerprint: Some(query_fingerprint),
                        ..Default::default()
                    },
                )?;
                Ok(Some(rec))
            },
        )
        .await
        .map_err(|e| e.to_string())??;

        Ok(stored.map(|rec| Self::build_result_from_record(&rec, &size, false, false)))
    }
}

fn artwork_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("artwork-v1"))
}

fn authorize_artwork_paths(app: &AppHandle, result: &NativeArtworkResult) {
    let scope = app.asset_protocol_scope();
    for p in [
        result.cached_path.as_deref(),
        result.thumb_path_500.as_deref(),
        result.thumb_path_256.as_deref(),
        result.original_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let _ = scope.allow_file(Path::new(p));
    }
}

#[tauri::command]
pub async fn extract_desktop_embedded_artwork(
    app: AppHandle,
    engine: tauri::State<'_, ArtworkEngine>,
    path: String,
    track_id: Option<String>,
    size: Option<String>,
) -> Result<Option<NativeArtworkResult>, String> {
    if path.len() > 4096 {
        return Err("Audio path exceeds maximum length.".into());
    }
    if track_id.as_ref().is_some_and(|id| id.len() > 2048) {
        return Err("trackId exceeds maximum length.".into());
    }
    let normalized = validate_safe_audio_path(Path::new(&path))?;
    if !app.asset_protocol_scope().is_allowed(&normalized) {
        return Err("File path is not authorized for desktop audio reading.".into());
    }
    let cache_dir = artwork_cache_dir(&app)?;
    let res = engine
        .extract_embedded(
            cache_dir,
            normalized,
            track_id,
            size.unwrap_or_else(|| "500".into()),
        )
        .await?;
    if let Some(ref art) = res {
        authorize_artwork_paths(&app, art);
    }
    Ok(res)
}

#[tauri::command]
pub async fn resolve_desktop_artwork(
    app: AppHandle,
    engine: tauri::State<'_, ArtworkEngine>,
    mut request: NativeArtworkResolveRequest,
) -> Result<NativeArtworkResult, String> {
    request.validate()?;
    if let Some(ref raw_path) = request.desktop_path {
        if !raw_path.trim().is_empty() {
            match validate_safe_audio_path(Path::new(raw_path)) {
                Ok(normalized) if app.asset_protocol_scope().is_allowed(&normalized) => {
                    request.desktop_path = Some(normalized.to_string_lossy().into_owned());
                }
                _ => {
                    request.desktop_path = None;
                }
            }
        }
    }
    let cache_dir = artwork_cache_dir(&app)?;
    let res = engine.resolve(cache_dir, request).await?;
    authorize_artwork_paths(&app, &res);
    Ok(res)
}

#[tauri::command]
pub async fn cache_desktop_remote_artwork(
    app: AppHandle,
    engine: tauri::State<'_, ArtworkEngine>,
    track: ArtworkQuery,
    url: String,
    source: Option<String>,
    size: Option<String>,
) -> Result<Option<NativeArtworkResult>, String> {
    track.validate()?;
    let cache_dir = artwork_cache_dir(&app)?;
    let res = engine
        .cache_remote_image(
            cache_dir,
            track,
            url,
            source.unwrap_or_else(|| "itunes".into()),
            size.unwrap_or_else(|| "500".into()),
        )
        .await?;
    if let Some(ref art) = res {
        authorize_artwork_paths(&app, art);
    }
    Ok(res)
}

#[tauri::command]
pub async fn read_desktop_cached_artwork_bytes(
    app: AppHandle,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    if path.len() > 4096 {
        return Err("Path exceeds maximum length.".into());
    }
    let cache_dir = artwork_cache_dir(&app)?;
    let raw_path = PathBuf::from(path);
    let bytes = tokio::task::spawn_blocking(move || {
        read_cached_blob_bytes_restricted(&cache_dir, &raw_path)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn invalidate_desktop_artwork_cache(
    app: AppHandle,
    request: NativeArtworkInvalidateRequest,
) -> Result<(), String> {
    let cache_dir = artwork_cache_dir(&app)?;
    tokio::task::spawn_blocking(move || invalidate_cache_entries(&cache_dir, &request))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, ImageFormat, Rgba};
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn sample_png(color: u8) -> Vec<u8> {
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_fn(600, 600, |x, y| {
            Rgba([(x % 255) as u8, (y % 255) as u8, color, 255])
        });
        let mut buf = Vec::new();
        img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .unwrap();
        buf
    }

    #[tokio::test]
    async fn resolves_downloads_resizes_and_serves_offline_from_disk_cache() {
        let png = sample_png(200);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_clone = hits.clone();

        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                hits_clone.fetch_add(1, Ordering::SeqCst);
                let png_clone = png.clone();
                let addr_str = addr.to_string();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req.split_whitespace().nth(1).unwrap_or("");
                    if path.starts_with("/cover.png") {
                        let hdr = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            png_clone.len()
                        );
                        let _ = stream.write_all(hdr.as_bytes()).await;
                        let _ = stream.write_all(&png_clone).await;
                    } else if path.starts_with("/search?") {
                        let body = serde_json::json!({
                            "resultCount": 1,
                            "results": [{
                                "trackName": "Starlight",
                                "artistName": "Muse",
                                "collectionName": "Black Holes and Revelations",
                                "artworkUrl100": format!("http://{addr_str}/cover.png"),
                                "trackTimeMillis": 240000
                            }]
                        })
                        .to_string();
                        let reply = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(reply.as_bytes()).await;
                    } else {
                        let body = "{}";
                        let reply = format!(
                            "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(reply.as_bytes()).await;
                    }
                });
            }
        });

        let engine = ArtworkEngine::with_test_endpoints(base.clone(), base.clone(), base);
        let dir = tempfile::tempdir().unwrap();
        let req = NativeArtworkResolveRequest {
            track: ArtworkQuery {
                id: "track-muse".into(),
                title: "Starlight".into(),
                artist: "Muse".into(),
                album: "Black Holes and Revelations".into(),
                duration_ms: Some(240_000),
            },
            desktop_path: None,
            size: Some("500".into()),
            force_refresh: false,
            offline: false,
            exclude_urls: vec![],
            download_and_cache: true,
        };

        let first = engine
            .resolve(dir.path().to_path_buf(), req.clone())
            .await
            .unwrap();
        assert_eq!(first.source, "itunes");
        assert!(first.cached_path.is_some());
        assert!(first.thumb_path_500.is_some());
        assert!(first.thumb_path_256.is_some());

        let calls_after_first = hits.load(Ordering::SeqCst);

        // Offline request serves directly from disk cache without hitting network
        let mut offline_req = req.clone();
        offline_req.offline = true;
        let second = engine
            .resolve(dir.path().to_path_buf(), offline_req)
            .await
            .unwrap();
        assert!(second.from_cache);
        assert!(second.offline);
        assert_eq!(second.cached_path, first.cached_path);
        assert_eq!(hits.load(Ordering::SeqCst), calls_after_first);

        server.abort();
    }

    #[tokio::test]
    async fn invalidates_stale_track_id_cache_on_metadata_change_and_preserves_shared_album_cache()
    {
        let png1 = sample_png(80);
        let png2 = sample_png(180);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");

        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let p1 = png1.clone();
                let p2 = png2.clone();
                let addr_str = addr.to_string();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req.split_whitespace().nth(1).unwrap_or("");
                    if path.starts_with("/cover1.png") {
                        let hdr = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            p1.len()
                        );
                        let _ = stream.write_all(hdr.as_bytes()).await;
                        let _ = stream.write_all(&p1).await;
                    } else if path.starts_with("/cover2.png") {
                        let hdr = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            p2.len()
                        );
                        let _ = stream.write_all(hdr.as_bytes()).await;
                        let _ = stream.write_all(&p2).await;
                    } else if path.starts_with("/search?") && path.contains("Updated") {
                        let body = serde_json::json!({
                            "resultCount": 1,
                            "results": [{
                                "trackName": "Updated Song",
                                "artistName": "Artist B",
                                "collectionName": "Album B",
                                "artworkUrl100": format!("http://{addr_str}/cover2.png"),
                                "trackTimeMillis": 200000
                            }]
                        })
                        .to_string();
                        let reply = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(reply.as_bytes()).await;
                    } else if path.starts_with("/search?") {
                        let body = serde_json::json!({
                            "resultCount": 1,
                            "results": [{
                                "trackName": "Initial Song",
                                "artistName": "Artist A",
                                "collectionName": "Album A",
                                "artworkUrl100": format!("http://{addr_str}/cover1.png"),
                                "trackTimeMillis": 200000
                            }]
                        })
                        .to_string();
                        let reply = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(reply.as_bytes()).await;
                    } else {
                        let reply =
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
                        let _ = stream.write_all(reply.as_bytes()).await;
                    }
                });
            }
        });

        let engine = ArtworkEngine::with_test_endpoints(base.clone(), base.clone(), base);
        let dir = tempfile::tempdir().unwrap();

        // 1. Resolve initial metadata for track "t-shared"
        let req1 = NativeArtworkResolveRequest {
            track: ArtworkQuery {
                id: "t-shared".into(),
                title: "Initial Song".into(),
                artist: "Artist A".into(),
                album: "Album A".into(),
                duration_ms: Some(200_000),
            },
            desktop_path: None,
            size: Some("500".into()),
            force_refresh: false,
            offline: false,
            exclude_urls: vec![],
            download_and_cache: true,
        };
        let res1 = engine
            .resolve(dir.path().to_path_buf(), req1.clone())
            .await
            .unwrap();
        assert!(res1.content_hash.is_some());

        // 2. Edit metadata on the same track ID ("t-shared") -> must NOT serve stale cover1 from `track::t-shared`
        let mut req_edited = req1.clone();
        req_edited.track.title = "Updated Song".into();
        req_edited.track.artist = "Artist B".into();
        req_edited.track.album = "Album B".into();

        let res_edited = engine
            .resolve(dir.path().to_path_buf(), req_edited)
            .await
            .unwrap();
        assert!(!res_edited.from_cache);
        assert_ne!(res_edited.content_hash, res1.content_hash);

        // 3. Meanwhile, a sibling track ("t-sibling") still in "Artist A - Album A" continues to get the shared album cache hit!
        // Deleting track "t-shared" with `include_album: Some(false)` preserves the album cache for "t-sibling".
        invalidate_cache_entries(
            dir.path(),
            &NativeArtworkInvalidateRequest {
                track_id: Some("t-shared".into()),
                title: Some("Initial Song".into()),
                artist: Some("Artist A".into()),
                album: Some("Album A".into()),
                include_album: Some(false),
                clear_all: false,
            },
        )
        .unwrap();

        let mut req_sibling = req1.clone();
        req_sibling.track.id = "t-sibling".into();
        req_sibling.track.title = "Track Two".into();
        req_sibling.offline = true;
        let res_sibling = engine
            .resolve(dir.path().to_path_buf(), req_sibling)
            .await
            .unwrap();
        assert!(res_sibling.from_cache);
        assert_eq!(res_sibling.content_hash, res1.content_hash);

        server.abort();
    }

    #[test]
    fn enforces_strict_blobs_root_and_rejects_traversal_index_files_and_oversized_reads() {
        let dir = tempfile::tempdir().unwrap();
        let cache_dir = dir.path().join("artwork-v1");
        let blobs_dir = cache_dir.join("blobs");
        let index_dir = cache_dir.join("index");
        fs::create_dir_all(&blobs_dir).unwrap();
        fs::create_dir_all(&index_dir).unwrap();

        let valid_blob = blobs_dir.join("hash123_500.jpg");
        let png = sample_png(120);
        fs::write(&valid_blob, &png).unwrap();

        // 1. Valid blob inside blobs/ succeeds
        let read_ok = read_cached_blob_bytes_restricted(&cache_dir, &valid_blob).unwrap();
        assert_eq!(read_ok, png);

        // 2. Index JSON file inside artwork-v1/index/ is rejected (outside blobs/)
        let idx_file = index_dir.join("secret.json");
        fs::write(&idx_file, [b'a'; 128]).unwrap();
        assert!(read_cached_blob_bytes_restricted(&cache_dir, &idx_file).is_err());

        // 3. Outside file or parent traversal is rejected
        let outside = dir.path().join("outside.jpg");
        fs::write(&outside, &png).unwrap();
        assert!(read_cached_blob_bytes_restricted(&cache_dir, &outside).is_err());
        let traversal = blobs_dir.join("..").join("..").join("outside.jpg");
        assert!(read_cached_blob_bytes_restricted(&cache_dir, &traversal).is_err());

        // 4. Non-image extension inside blobs/ is rejected
        let bad_ext = blobs_dir.join("hash123.json");
        fs::write(&bad_ext, [b'a'; 128]).unwrap();
        assert!(read_cached_blob_bytes_restricted(&cache_dir, &bad_ext).is_err());
    }
}
