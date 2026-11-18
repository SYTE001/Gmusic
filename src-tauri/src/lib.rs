use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

mod artwork;
mod lyrics;
mod persistence;

const SUPPORTED_AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "m4b", "aac", "wav", "wave", "ogg", "oga", "opus", "flac", "weba", "webm", "mp4",
];

const MAX_SLICE_BYTES: usize = 24 * 1024 * 1024;
const MAX_FOLDER_DEPTH: usize = 16;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAudioFileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPathStatus {
    pub path: String,
    pub exists: bool,
}

pub fn is_supported_audio_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| SUPPORTED_AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn mime_type_for_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "m4a" | "m4b" | "mp4" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" | "wave" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "weba" | "webm" => "audio/webm",
        _ => "",
    }
}

/// Strips Windows `\\?\` verbatim prefix after canonicalization so paths remain
/// compatible with WebView2 asset URLs and standard path checks.
pub(crate) fn normalize_fs_path(path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|err| format!("Failed to resolve path {}: {err}", path.display()))?;
    #[cfg(windows)]
    {
        if let Some(raw) = canonical.to_str() {
            if let Some(stripped) = raw.strip_prefix(r"\\?\") {
                if !stripped.starts_with(r"UNC\") {
                    return Ok(PathBuf::from(stripped));
                }
            }
        }
    }
    Ok(canonical)
}

fn build_audio_info(path: &Path) -> Result<Option<DesktopAudioFileInfo>, String> {
    let Ok(sym_meta) = fs::symlink_metadata(path) else {
        return Ok(None);
    };
    if sym_meta.file_type().is_symlink() || !sym_meta.is_file() {
        return Ok(None);
    }
    let normalized = normalize_fs_path(path)?;
    let metadata = fs::metadata(&normalized)
        .map_err(|err| format!("Failed to inspect {}: {err}", normalized.display()))?;
    if !metadata.is_file() || !is_supported_audio_extension(&normalized) {
        return Ok(None);
    }
    let name = normalized
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Invalid UTF-8 file name: {}", normalized.display()))?
        .to_string();

    Ok(Some(DesktopAudioFileInfo {
        mime_type: mime_type_for_path(&normalized).to_string(),
        path: normalized.to_string_lossy().into_owned(),
        name,
        size: metadata.len(),
    }))
}

pub fn collect_audio_files_in_dir(dir: &Path, max_depth: usize) -> Result<Vec<PathBuf>, String> {
    if !dir.is_dir() {
        return Err(format!("Selected path is not a folder: {}", dir.display()));
    }
    let mut results = Vec::new();
    collect_audio_files_recursive(dir, 0, max_depth, &mut results)?;
    results.sort();
    Ok(results)
}

fn collect_audio_files_recursive(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > max_depth {
        return Ok(());
    }
    let entries = fs::read_dir(dir)
        .map_err(|err| format!("Failed to read folder {}: {err}", dir.display()))?;

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(sym_meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if sym_meta.file_type().is_symlink() {
            continue;
        }
        if sym_meta.is_dir() {
            let is_hidden = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with('.'))
                .unwrap_or(false);
            if !is_hidden {
                let _ = collect_audio_files_recursive(&path, depth + 1, max_depth, out);
            }
        } else if sym_meta.is_file() && is_supported_audio_extension(&path) {
            if let Ok(normalized) = normalize_fs_path(&path) {
                out.push(normalized);
            }
        }
    }
    Ok(())
}

pub fn read_slice_from_file(path: &Path, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    let clamped_len = length.min(MAX_SLICE_BYTES);
    if clamped_len == 0 {
        return Ok(Vec::new());
    }
    let mut file =
        File::open(path).map_err(|err| format!("Failed to open {}: {err}", path.display()))?;
    let file_len = file
        .metadata()
        .map_err(|err| format!("Failed to read metadata for {}: {err}", path.display()))?
        .len();
    if offset >= file_len {
        return Ok(Vec::new());
    }
    let remaining = (file_len - offset) as usize;
    let to_read = clamped_len.min(remaining);
    file.seek(SeekFrom::Start(offset))
        .map_err(|err| format!("Failed to seek {}: {err}", path.display()))?;
    let mut buf = vec![0u8; to_read];
    file.read_exact(&mut buf)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    Ok(buf)
}

#[tauri::command]
fn inspect_audio_paths(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<DesktopAudioFileInfo>, String> {
    let scope = app.asset_protocol_scope();
    let mut collected = Vec::new();
    for raw_path in paths {
        let candidate = Path::new(&raw_path);
        if !candidate.exists() {
            continue;
        }
        if let Some(info) = build_audio_info(candidate)? {
            scope
                .allow_file(Path::new(&info.path))
                .map_err(|err| format!("Failed to authorize asset scope: {err}"))?;
            collected.push(info);
        }
    }
    Ok(collected)
}

#[tauri::command]
fn scan_audio_folder(
    app: AppHandle,
    dir_path: String,
) -> Result<Vec<DesktopAudioFileInfo>, String> {
    let root = normalize_fs_path(Path::new(&dir_path))?;
    let files = collect_audio_files_in_dir(&root, MAX_FOLDER_DEPTH)?;
    let scope = app.asset_protocol_scope();
    let mut collected = Vec::with_capacity(files.len());
    for file_path in files {
        if let Some(info) = build_audio_info(&file_path)? {
            scope
                .allow_file(Path::new(&info.path))
                .map_err(|err| format!("Failed to authorize asset scope: {err}"))?;
            collected.push(info);
        }
    }
    Ok(collected)
}

#[tauri::command]
fn authorize_desktop_paths(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<DesktopPathStatus>, String> {
    let scope = app.asset_protocol_scope();
    let mut statuses = Vec::with_capacity(paths.len());
    for raw_path in paths {
        let candidate = Path::new(&raw_path);
        let is_regular = fs::symlink_metadata(candidate)
            .map(|m| !m.file_type().is_symlink() && m.is_file())
            .unwrap_or(false);
        let exists = if is_regular && is_supported_audio_extension(candidate) {
            if let Ok(normalized) = normalize_fs_path(candidate) {
                scope.allow_file(&normalized).is_ok()
            } else {
                false
            }
        } else {
            false
        };
        statuses.push(DesktopPathStatus {
            path: raw_path,
            exists,
        });
    }
    Ok(statuses)
}

#[tauri::command]
fn read_audio_file_slice(
    app: AppHandle,
    path: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    let raw_path = Path::new(&path);
    let sym_meta = fs::symlink_metadata(raw_path)
        .map_err(|err| format!("Failed to inspect {}: {err}", raw_path.display()))?;
    if sym_meta.file_type().is_symlink() {
        return Err("Symlink audio paths are not permitted.".to_string());
    }
    let normalized = normalize_fs_path(raw_path)?;
    if !is_supported_audio_extension(&normalized) {
        return Err("Unsupported audio file extension.".to_string());
    }
    if !app.asset_protocol_scope().is_allowed(&normalized) {
        return Err("File path is not authorized for desktop audio reading.".to_string());
    }
    let bytes = read_slice_from_file(&normalized, offset, length as usize)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(lyrics::LyricsEngine::new().expect("create lyrics engine"))
        .manage(artwork::ArtworkEngine::new().expect("create artwork engine"))
        .manage(persistence::PersistenceEngine::new().expect("create persistence engine"))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            inspect_audio_paths,
            scan_audio_folder,
            authorize_desktop_paths,
            read_audio_file_slice,
            lyrics::discover_desktop_lyrics,
            lyrics::parse_desktop_lyrics,
            artwork::extract_desktop_embedded_artwork,
            artwork::resolve_desktop_artwork,
            artwork::cache_desktop_remote_artwork,
            artwork::read_desktop_cached_artwork_bytes,
            artwork::invalidate_desktop_artwork_cache,
            persistence::get_desktop_persistence_status,
            persistence::begin_desktop_idb_migration,
            persistence::write_desktop_idb_migration_batch,
            persistence::finalize_desktop_idb_migration,
            persistence::fail_desktop_idb_migration,
            persistence::sqlite_list_tracks,
            persistence::sqlite_get_track,
            persistence::sqlite_put_tracks,
            persistence::sqlite_put_track_with_files,
            persistence::sqlite_delete_tracks,
            persistence::sqlite_get_artwork,
            persistence::sqlite_put_artwork,
            persistence::sqlite_delete_artwork,
            persistence::sqlite_list_artwork_track_ids,
            persistence::sqlite_get_audio_blob,
            persistence::sqlite_put_audio_blob,
            persistence::sqlite_delete_audio_blob,
            persistence::sqlite_count_stored_audio,
            persistence::sqlite_list_audio_track_ids,
            persistence::sqlite_list_playlists,
            persistence::sqlite_get_playlist,
            persistence::sqlite_put_playlist,
            persistence::sqlite_delete_playlist,
            persistence::sqlite_get_lyrics,
            persistence::sqlite_put_lyrics,
            persistence::sqlite_delete_lyrics,
            persistence::sqlite_get_lyrics_cache_meta,
            persistence::sqlite_put_lyrics_cache_meta,
            persistence::sqlite_get_pref_json,
            persistence::sqlite_put_pref_json,
            persistence::sqlite_delete_pref,
            persistence::sqlite_clear_library,
            persistence::sqlite_replace_library,
            persistence::sqlite_clear_all_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gmusic desktop application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("gmusic_test_{label}_{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn recognizes_supported_audio_extensions_case_insensitively() {
        assert!(is_supported_audio_extension(Path::new("track.mp3")));
        assert!(is_supported_audio_extension(Path::new("TRACK.FLAC")));
        assert!(is_supported_audio_extension(Path::new("song.M4A")));
        assert!(is_supported_audio_extension(Path::new("voice.opus")));
        assert!(!is_supported_audio_extension(Path::new("lyrics.lrc")));
        assert!(!is_supported_audio_extension(Path::new("cover.png")));
        assert!(!is_supported_audio_extension(Path::new("no_extension")));
    }

    #[test]
    fn maps_expected_mime_types() {
        assert_eq!(mime_type_for_path(Path::new("a.mp3")), "audio/mpeg");
        assert_eq!(mime_type_for_path(Path::new("a.flac")), "audio/flac");
        assert_eq!(mime_type_for_path(Path::new("a.m4a")), "audio/mp4");
        assert_eq!(mime_type_for_path(Path::new("a.wav")), "audio/wav");
        assert_eq!(mime_type_for_path(Path::new("a.ogg")), "audio/ogg");
        assert_eq!(mime_type_for_path(Path::new("a.txt")), "");
    }

    #[test]
    fn collects_audio_files_recursively_and_skips_hidden_and_non_audio() {
        let root = unique_temp_dir("scan");
        let nested = root.join("Album");
        let hidden = root.join(".git");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&hidden).unwrap();

        fs::write(root.join("01.mp3"), b"mp3").unwrap();
        fs::write(nested.join("02.flac"), b"flac").unwrap();
        fs::write(root.join("notes.txt"), b"txt").unwrap();
        fs::write(hidden.join("ignored.mp3"), b"hidden").unwrap();

        let found = collect_audio_files_in_dir(&root, MAX_FOLDER_DEPTH).unwrap();
        let names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["01.mp3".to_string(), "02.flac".to_string()]);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_bounded_file_slices_safely() {
        let root = unique_temp_dir("slice");
        let file_path = root.join("sample.wav");
        fs::write(&file_path, b"0123456789ABCDEF").unwrap();

        assert_eq!(read_slice_from_file(&file_path, 0, 4).unwrap(), b"0123");
        assert_eq!(read_slice_from_file(&file_path, 12, 10).unwrap(), b"CDEF");
        assert_eq!(read_slice_from_file(&file_path, 99, 4).unwrap(), b"");
        assert_eq!(read_slice_from_file(&file_path, 0, 0).unwrap(), b"");

        fs::remove_dir_all(&root).unwrap();
    }
}
