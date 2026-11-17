use super::process::{generate_thumbnail, validate_and_inspect_image, ValidatedImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const CACHE_SCHEMA_VERSION: u32 = 1;
pub const POSITIVE_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;
pub const NEGATIVE_TTL_MS: u64 = 24 * 60 * 60 * 1000;
pub const DEFAULT_MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_INDEX_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachedArtworkRecord {
    #[serde(default)]
    pub version: u32,
    pub key: String,
    pub track_id: Option<String>,
    pub content_hash: Option<String>,
    pub mime_type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub source: String,
    pub url: Option<String>,
    pub release_group_mbid: Option<String>,
    pub release_mbid: Option<String>,
    pub confidence: u32,
    pub album: Option<String>,
    pub artist: Option<String>,
    pub negative: bool,
    pub saved_at: u64,
    pub thumb_path_500: Option<String>,
    pub thumb_path_256: Option<String>,
    pub original_path: Option<String>,
}

impl CachedArtworkRecord {
    pub fn is_fresh(&self, now: u64) -> bool {
        let ttl = if self.negative {
            NEGATIVE_TTL_MS
        } else {
            POSITIVE_TTL_MS
        };
        now >= self.saved_at && now - self.saved_at < ttl
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn hash_key(raw: &str) -> String {
    format!("{:x}", Sha256::digest(raw.as_bytes()))
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

fn atomic_write_file(dir: &Path, target_path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|e| format!("Could not create artwork cache directory: {e}"))?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)
        .map_err(|e| format!("Could not create temp cache file: {e}"))?;
    temp.write_all(bytes)
        .and_then(|()| temp.as_file().sync_all())
        .map_err(|e| format!("Could not flush artwork cache file: {e}"))?;
    temp.persist(target_path)
        .map_err(|e| format!("Could not persist artwork cache file: {e}"))?;
    Ok(())
}

pub fn write_index_record(
    cache_dir: &Path,
    key: &str,
    record: &CachedArtworkRecord,
) -> Result<(), String> {
    let index_dir = cache_dir.join("index");
    let key_hash = hash_key(key);
    let mut rec = record.clone();
    rec.version = CACHE_SCHEMA_VERSION;
    rec.key = key.to_string();
    let payload = serde_json::to_vec(&rec).map_err(|e| e.to_string())?;
    let target = index_dir.join(format!("{key_hash}.json"));
    atomic_write_file(&index_dir, &target, &payload)
}

pub fn store_negative_record(
    cache_dir: &Path,
    keys: &[String],
    meta: CachedArtworkRecord,
) -> Result<CachedArtworkRecord, String> {
    let mut rec = meta;
    rec.version = CACHE_SCHEMA_VERSION;
    rec.negative = true;
    rec.source = "none".into();
    rec.saved_at = now_ms();
    rec.content_hash = None;
    rec.original_path = None;
    rec.thumb_path_500 = None;
    rec.thumb_path_256 = None;

    for key in keys.iter().filter(|k| !k.trim().is_empty()) {
        write_index_record(cache_dir, key, &rec)?;
    }
    Ok(rec)
}

pub fn store_artwork_blob(
    cache_dir: &Path,
    keys: &[String],
    track_id: Option<&str>,
    image: &ValidatedImage,
    source: &str,
    meta: CachedArtworkRecord,
) -> Result<CachedArtworkRecord, String> {
    let blobs_dir = cache_dir.join("blobs");
    fs::create_dir_all(&blobs_dir)
        .map_err(|e| format!("Could not create artwork blobs directory: {e}"))?;

    let content_hash = format!("{:x}", Sha256::digest(&image.bytes));
    let orig_ext = ext_for_mime(&image.mime_type);
    let orig_path = blobs_dir.join(format!("{content_hash}_orig.{orig_ext}"));

    if !orig_path.exists() {
        atomic_write_file(&blobs_dir, &orig_path, &image.bytes)?;
    }

    let thumb_500 = generate_thumbnail(image, 500)?;
    let t500_ext = ext_for_mime(&thumb_500.mime_type);
    let t500_path = if thumb_500.bytes == image.bytes {
        orig_path.clone()
    } else {
        let p = blobs_dir.join(format!("{content_hash}_500.{t500_ext}"));
        if !p.exists() {
            atomic_write_file(&blobs_dir, &p, &thumb_500.bytes)?;
        }
        p
    };

    let thumb_256 = generate_thumbnail(image, 256)?;
    let t256_ext = ext_for_mime(&thumb_256.mime_type);
    let t256_path = if thumb_256.bytes == image.bytes {
        orig_path.clone()
    } else {
        let p = blobs_dir.join(format!("{content_hash}_256.{t256_ext}"));
        if !p.exists() {
            atomic_write_file(&blobs_dir, &p, &thumb_256.bytes)?;
        }
        p
    };

    let mut rec = meta;
    rec.version = CACHE_SCHEMA_VERSION;
    rec.track_id = track_id.map(String::from);
    rec.content_hash = Some(content_hash);
    rec.mime_type = Some(image.mime_type.clone());
    rec.width = Some(image.width);
    rec.height = Some(image.height);
    rec.source = source.into();
    rec.negative = false;
    rec.saved_at = now_ms();
    rec.original_path = Some(orig_path.to_string_lossy().into_owned());
    rec.thumb_path_500 = Some(t500_path.to_string_lossy().into_owned());
    rec.thumb_path_256 = Some(t256_path.to_string_lossy().into_owned());

    let mut all_keys: Vec<String> = keys
        .iter()
        .filter(|k| !k.trim().is_empty())
        .cloned()
        .collect();
    if let Some(tid) = track_id.filter(|s| !s.trim().is_empty()) {
        let tk = format!("track::{tid}");
        if !all_keys.contains(&tk) {
            all_keys.push(tk);
        }
    }
    for key in &all_keys {
        write_index_record(cache_dir, key, &rec)?;
    }

    let _ = prune_cache(cache_dir, DEFAULT_MAX_CACHE_BYTES);
    Ok(rec)
}

pub fn read_cached_artwork(
    cache_dir: &Path,
    key: &str,
    allow_stale_positive: bool,
) -> Result<Option<CachedArtworkRecord>, String> {
    if key.trim().is_empty() {
        return Ok(None);
    }
    let index_path = cache_dir
        .join("index")
        .join(format!("{}.json", hash_key(key)));
    let meta = match fs::metadata(&index_path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not inspect artwork cache index: {e}")),
    };
    if meta.len() > MAX_INDEX_BYTES {
        let _ = fs::remove_file(&index_path);
        return Ok(None);
    }
    let Ok(bytes) = fs::read(&index_path) else {
        let _ = fs::remove_file(&index_path);
        return Ok(None);
    };
    let Ok(record) = serde_json::from_slice::<CachedArtworkRecord>(&bytes) else {
        let _ = fs::remove_file(&index_path);
        return Ok(None);
    };
    if record.version != CACHE_SCHEMA_VERSION || record.key != key {
        let _ = fs::remove_file(&index_path);
        return Ok(None);
    }

    let now = now_ms();
    if !record.is_fresh(now) && !(allow_stale_positive && !record.negative) {
        let _ = fs::remove_file(&index_path);
        return Ok(None);
    }

    if !record.negative {
        let Some(orig_str) = record.original_path.as_deref() else {
            let _ = fs::remove_file(&index_path);
            return Ok(None);
        };
        let orig_path = Path::new(orig_str);
        let Ok(img_bytes) = fs::read(orig_path) else {
            let _ = fs::remove_file(&index_path);
            return Ok(None);
        };
        // Verify content hash and image decodability so corrupted disk files are healed
        if let Some(expected_hash) = record.content_hash.as_deref() {
            let actual_hash = format!("{:x}", Sha256::digest(&img_bytes));
            if actual_hash != expected_hash {
                let _ = fs::remove_file(orig_path);
                let _ = fs::remove_file(&index_path);
                return Ok(None);
            }
        }
        if validate_and_inspect_image(&img_bytes).is_err() {
            let _ = fs::remove_file(orig_path);
            let _ = fs::remove_file(&index_path);
            return Ok(None);
        }
    }

    Ok(Some(record))
}

pub fn invalidate_keys(cache_dir: &Path, keys: &[String]) -> Result<(), String> {
    let index_dir = cache_dir.join("index");
    for key in keys.iter().filter(|k| !k.trim().is_empty()) {
        let p = index_dir.join(format!("{}.json", hash_key(key)));
        let _ = fs::remove_file(p);
    }
    Ok(())
}

pub fn blob_path_for_record(record: &CachedArtworkRecord, size: u32) -> Option<PathBuf> {
    let chosen = if size > 0 && size <= 256 {
        record
            .thumb_path_256
            .as_deref()
            .or(record.thumb_path_500.as_deref())
            .or(record.original_path.as_deref())
    } else if size > 0 && size <= 600 {
        record
            .thumb_path_500
            .as_deref()
            .or(record.original_path.as_deref())
    } else {
        record
            .original_path
            .as_deref()
            .or(record.thumb_path_500.as_deref())
    };
    chosen.map(PathBuf::from).filter(|p| p.is_file())
}

pub fn prune_cache(cache_dir: &Path, max_bytes: u64) -> Result<(), String> {
    let blobs_dir = cache_dir.join("blobs");
    let index_dir = cache_dir.join("index");
    if !blobs_dir.is_dir() {
        return Ok(());
    }

    let mut total_bytes = 0u64;
    let mut blob_files: Vec<(PathBuf, u64)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&blobs_dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total_bytes += meta.len();
                    blob_files.push((entry.path(), meta.len()));
                }
            }
        }
    }

    if total_bytes <= max_bytes {
        return Ok(());
    }

    // Collect index entries sorted by saved_at ascending (oldest first)
    let mut index_entries: Vec<(PathBuf, CachedArtworkRecord)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&index_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(bytes) = fs::read(&path) {
                if let Ok(rec) = serde_json::from_slice::<CachedArtworkRecord>(&bytes) {
                    index_entries.push((path, rec));
                } else {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
    index_entries.sort_by_key(|(_, rec)| rec.saved_at);

    // Evict oldest 25% of index entries when over budget, then remove unreferenced blobs
    let remove_count = (index_entries.len() / 4).max(1);
    for (idx_path, _) in index_entries.iter().take(remove_count) {
        let _ = fs::remove_file(idx_path);
    }

    let mut referenced_hashes: HashSet<String> = HashSet::new();
    for (_, rec) in index_entries.into_iter().skip(remove_count) {
        if let Some(h) = rec.content_hash {
            referenced_hashes.insert(h);
        }
    }

    for (blob_path, _) in blob_files {
        let fname = blob_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let is_ref = referenced_hashes
            .iter()
            .any(|h| fname.starts_with(h.as_str()));
        if !is_ref {
            let _ = fs::remove_file(blob_path);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artwork::process::validate_and_inspect_image;
    use image::{ImageBuffer, ImageFormat, Rgba};
    use std::fs;
    use std::io::Cursor;

    fn sample_image(w: u32, h: u32, color: u8) -> ValidatedImage {
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
            ImageBuffer::from_fn(w, h, |_, _| Rgba([color, 100, 200, 255]));
        let mut buf = Vec::new();
        img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .unwrap();
        validate_and_inspect_image(&buf).unwrap()
    }

    #[test]
    fn deduplicates_identical_artwork_and_recovers_from_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let img = sample_image(600, 600, 42);

        let r1 = store_artwork_blob(
            dir.path(),
            &["album::daft punk::discovery".into(), "track::t1".into()],
            Some("t1"),
            &img,
            "embedded",
            CachedArtworkRecord::default(),
        )
        .unwrap();
        let r2 = store_artwork_blob(
            dir.path(),
            &["track::t2".into()],
            Some("t2"),
            &img,
            "embedded",
            CachedArtworkRecord::default(),
        )
        .unwrap();

        assert_eq!(r1.content_hash, r2.content_hash);
        assert_eq!(r1.original_path, r2.original_path);

        // Read back from cache
        let loaded = read_cached_artwork(dir.path(), "track::t1", false)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.content_hash, r1.content_hash);

        // Corrupt the underlying image file on disk -> read_cached_artwork detects and evicts cleanly
        let orig_path = PathBuf::from(loaded.original_path.unwrap());
        fs::write(&orig_path, b"corrupted-not-an-image").unwrap();
        assert!(read_cached_artwork(dir.path(), "track::t1", false)
            .unwrap()
            .is_none());
    }

    #[test]
    fn prunes_unbounded_cache_growth_and_evicts_unreferenced_blobs() {
        let dir = tempfile::tempdir().unwrap();
        let img1 = sample_image(400, 400, 10);
        let img2 = sample_image(400, 400, 20);

        store_artwork_blob(
            dir.path(),
            &["track::old".into()],
            Some("old"),
            &img1,
            "itunes",
            CachedArtworkRecord::default(),
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        store_artwork_blob(
            dir.path(),
            &["track::new".into()],
            Some("new"),
            &img2,
            "itunes",
            CachedArtworkRecord::default(),
        )
        .unwrap();

        // Prune with a tiny limit (1 byte) so the oldest entry and its blob are evicted
        prune_cache(dir.path(), 1).unwrap();
        assert!(read_cached_artwork(dir.path(), "track::old", false)
            .unwrap()
            .is_none());
        assert!(read_cached_artwork(dir.path(), "track::new", false)
            .unwrap()
            .is_some());
    }
}
