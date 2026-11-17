use super::process::{generate_thumbnail, validate_and_inspect_image, ValidatedImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
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
    #[serde(default)]
    pub last_accessed_at: u64,
    #[serde(default)]
    pub query_fingerprint: Option<String>,
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

    pub fn effective_last_accessed(&self) -> u64 {
        if self.last_accessed_at > 0 {
            self.last_accessed_at
        } else {
            self.saved_at
        }
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
    let now = now_ms();
    let mut rec = meta;
    rec.version = CACHE_SCHEMA_VERSION;
    rec.negative = true;
    rec.source = "none".into();
    rec.saved_at = now;
    rec.last_accessed_at = now;
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

    let now = now_ms();
    let mut rec = meta;
    rec.version = CACHE_SCHEMA_VERSION;
    rec.track_id = track_id.map(String::from);
    rec.content_hash = Some(content_hash);
    rec.mime_type = Some(image.mime_type.clone());
    rec.width = Some(image.width);
    rec.height = Some(image.height);
    rec.source = source.into();
    rec.negative = false;
    rec.saved_at = now;
    rec.last_accessed_at = now;
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
    let Ok(mut record) = serde_json::from_slice::<CachedArtworkRecord>(&bytes) else {
        let _ = fs::remove_file(&index_path);
        return Ok(None);
    };
    if record.version != CACHE_SCHEMA_VERSION || record.key != key {
        let _ = fs::remove_file(&index_path);
        return Ok(None);
    }

    // Offline lookups must never treat negative cache records as hits
    if allow_stale_positive && record.negative {
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

    // Genuine LRU: update last_accessed_at on every valid read
    record.last_accessed_at = now.max(record.effective_last_accessed() + 1);
    let _ = write_index_record(cache_dir, key, &record);

    Ok(Some(record))
}

fn remove_unreferenced_blobs(cache_dir: &Path) {
    let blobs_dir = cache_dir.join("blobs");
    let index_dir = cache_dir.join("index");
    if !blobs_dir.is_dir() {
        return;
    }

    let mut referenced_hashes: HashSet<String> = HashSet::new();
    if let Ok(entries) = fs::read_dir(&index_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(bytes) = fs::read(&path) {
                if let Ok(rec) = serde_json::from_slice::<CachedArtworkRecord>(&bytes) {
                    if let Some(h) = rec.content_hash {
                        referenced_hashes.insert(h);
                    }
                } else {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }

    if let Ok(entries) = fs::read_dir(&blobs_dir) {
        for entry in entries.flatten() {
            let blob_path = entry.path();
            if !blob_path.is_file() {
                continue;
            }
            let fname = blob_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let hash_prefix = fname.split('_').next().unwrap_or("");
            if hash_prefix.is_empty() || !referenced_hashes.contains(hash_prefix) {
                let _ = fs::remove_file(blob_path);
            }
        }
    }
}

pub fn invalidate_keys(cache_dir: &Path, keys: &[String]) -> Result<(), String> {
    let index_dir = cache_dir.join("index");
    for key in keys.iter().filter(|k| !k.trim().is_empty()) {
        let p = index_dir.join(format!("{}.json", hash_key(key)));
        let _ = fs::remove_file(p);
    }
    remove_unreferenced_blobs(cache_dir);
    Ok(())
}

pub fn clear_all_cache(cache_dir: &Path) -> Result<(), String> {
    for sub in ["index", "blobs"] {
        let dir = cache_dir.join(sub);
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let _ = fs::remove_file(p);
                }
            }
        }
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

    // 1. Scan index files, removing corrupt or dangling entries and grouping by content_hash
    let mut hash_groups: HashMap<String, Vec<(PathBuf, CachedArtworkRecord, u64)>> = HashMap::new();
    let mut hashless_indices: Vec<(PathBuf, CachedArtworkRecord, u64)> = Vec::new();
    let mut total_index_bytes = 0u64;

    if let Ok(entries) = fs::read_dir(&index_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("json")
                || meta.len() > MAX_INDEX_BYTES
            {
                let _ = fs::remove_file(&path);
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                let _ = fs::remove_file(&path);
                continue;
            };
            let Ok(rec) = serde_json::from_slice::<CachedArtworkRecord>(&bytes) else {
                let _ = fs::remove_file(&path);
                continue;
            };
            if !rec.negative {
                let orig_ok = rec
                    .original_path
                    .as_deref()
                    .is_some_and(|p| Path::new(p).is_file());
                if !orig_ok || rec.content_hash.is_none() {
                    let _ = fs::remove_file(&path);
                    continue;
                }
            }
            let file_len = meta.len();
            total_index_bytes += file_len;
            if let Some(ref h) = rec.content_hash {
                hash_groups
                    .entry(h.clone())
                    .or_default()
                    .push((path, rec, file_len));
            } else {
                hashless_indices.push((path, rec, file_len));
            }
        }
    }

    // 2. Scan blob files, deleting unreferenced orphan blobs immediately
    let mut blobs_by_hash: HashMap<String, Vec<(PathBuf, u64)>> = HashMap::new();
    let mut total_blob_bytes = 0u64;

    if let Ok(entries) = fs::read_dir(&blobs_dir) {
        for entry in entries.flatten() {
            let blob_path = entry.path();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let fname = blob_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let hash_prefix = fname.split('_').next().unwrap_or("").to_string();
            if hash_prefix.is_empty() || !hash_groups.contains_key(&hash_prefix) {
                let _ = fs::remove_file(&blob_path);
                continue;
            }
            let len = meta.len();
            total_blob_bytes += len;
            blobs_by_hash
                .entry(hash_prefix)
                .or_default()
                .push((blob_path, len));
        }
    }

    // Measure total bytes in blobs/ (and index/ when max_bytes is small or exceeded)
    let mut total_bytes = total_blob_bytes + total_index_bytes;
    if total_bytes <= max_bytes {
        return Ok(());
    }

    // 3. Sort content-addressed blob groups by genuine LRU (max last_accessed_at across referencing indices)
    struct EvictionGroup {
        content_hash: String,
        last_accessed: u64,
        saved_at: u64,
        index_files: Vec<(PathBuf, u64)>,
        blob_files: Vec<(PathBuf, u64)>,
    }

    let mut groups: Vec<EvictionGroup> = hash_groups
        .into_iter()
        .map(|(content_hash, records)| {
            let last_accessed = records
                .iter()
                .map(|(_, r, _)| r.effective_last_accessed())
                .max()
                .unwrap_or(0);
            let saved_at = records
                .iter()
                .map(|(_, r, _)| r.saved_at)
                .max()
                .unwrap_or(0);
            let index_files = records.into_iter().map(|(p, _, len)| (p, len)).collect();
            let blob_files = blobs_by_hash.remove(&content_hash).unwrap_or_default();
            EvictionGroup {
                content_hash,
                last_accessed,
                saved_at,
                index_files,
                blob_files,
            }
        })
        .collect();

    groups.sort_by(|a, b| {
        a.last_accessed
            .cmp(&b.last_accessed)
            .then_with(|| a.saved_at.cmp(&b.saved_at))
            .then_with(|| a.content_hash.cmp(&b.content_hash))
    });

    // Evict least-recently-used blob groups until total_bytes <= max_bytes
    for group in groups {
        if total_bytes <= max_bytes {
            break;
        }
        for (idx_path, idx_len) in group.index_files {
            let _ = fs::remove_file(idx_path);
            total_bytes = total_bytes.saturating_sub(idx_len);
        }
        for (blob_path, blob_len) in group.blob_files {
            let _ = fs::remove_file(blob_path);
            total_bytes = total_bytes.saturating_sub(blob_len);
        }
    }

    // 4. If still over max_bytes, evict oldest negative/hashless index records
    if total_bytes > max_bytes && !hashless_indices.is_empty() {
        hashless_indices.sort_by_key(|(_, rec, _)| (rec.effective_last_accessed(), rec.saved_at));
        for (idx_path, _, idx_len) in hashless_indices {
            if total_bytes <= max_bytes {
                break;
            }
            let _ = fs::remove_file(idx_path);
            total_bytes = total_bytes.saturating_sub(idx_len);
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
        let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_fn(w, h, |x, y| {
            Rgba([color, (x % 251) as u8, (y % 251) as u8, 255])
        });
        let mut buf = Vec::new();
        img.write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .unwrap();
        validate_and_inspect_image(&buf).unwrap()
    }

    fn total_cache_bytes(cache_dir: &Path) -> u64 {
        let mut sum = 0u64;
        for sub in ["blobs", "index"] {
            if let Ok(entries) = fs::read_dir(cache_dir.join(sub)) {
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        if meta.is_file() {
                            sum += meta.len();
                        }
                    }
                }
            }
        }
        sum
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
    fn enforces_max_bytes_budget_including_shared_content_addressed_blobs() {
        let dir = tempfile::tempdir().unwrap();
        let img1 = sample_image(400, 400, 10);
        let img2 = sample_image(400, 400, 20);
        let img3 = sample_image(400, 400, 30);

        // Store img1 shared across 3 keys (track + album + artist::title)
        store_artwork_blob(
            dir.path(),
            &[
                "track::t1".into(),
                "album::artist1::album1".into(),
                "artist1::song1".into(),
            ],
            Some("t1"),
            &img1,
            "itunes",
            CachedArtworkRecord::default(),
        )
        .unwrap();
        let one_entry_bytes = total_cache_bytes(dir.path());
        assert!(one_entry_bytes > 0);

        std::thread::sleep(std::time::Duration::from_millis(5));
        store_artwork_blob(
            dir.path(),
            &[
                "track::t2".into(),
                "album::artist2::album2".into(),
                "artist2::song2".into(),
            ],
            Some("t2"),
            &img2,
            "itunes",
            CachedArtworkRecord::default(),
        )
        .unwrap();

        std::thread::sleep(std::time::Duration::from_millis(5));
        store_artwork_blob(
            dir.path(),
            &[
                "track::t3".into(),
                "album::artist3::album3".into(),
                "artist3::song3".into(),
            ],
            Some("t3"),
            &img3,
            "itunes",
            CachedArtworkRecord::default(),
        )
        .unwrap();

        let total_before = total_cache_bytes(dir.path());
        assert!(total_before > one_entry_bytes * 2);

        // Prune to budget that fits only 1 shared blob group
        let budget = one_entry_bytes + 128;
        prune_cache(dir.path(), budget).unwrap();

        let total_after = total_cache_bytes(dir.path());
        assert!(
            total_after <= budget,
            "expected total_after ({total_after}) <= budget ({budget})"
        );
        assert!(read_cached_artwork(dir.path(), "track::t1", false)
            .unwrap()
            .is_none());
        assert!(
            read_cached_artwork(dir.path(), "album::artist1::album1", false)
                .unwrap()
                .is_none()
        );
        assert!(read_cached_artwork(dir.path(), "track::t2", false)
            .unwrap()
            .is_none());
        assert!(read_cached_artwork(dir.path(), "track::t3", false)
            .unwrap()
            .is_some());
    }

    #[test]
    fn evicts_least_recently_accessed_entry_and_supports_legacy_records_without_last_accessed() {
        let dir = tempfile::tempdir().unwrap();
        let img_older = sample_image(300, 300, 50);
        let img_newer = sample_image(300, 300, 90);

        store_artwork_blob(
            dir.path(),
            &["track::older".into()],
            Some("older"),
            &img_older,
            "itunes",
            CachedArtworkRecord::default(),
        )
        .unwrap();
        let single_bytes = total_cache_bytes(dir.path());

        std::thread::sleep(std::time::Duration::from_millis(10));
        store_artwork_blob(
            dir.path(),
            &["track::newer".into()],
            Some("newer"),
            &img_newer,
            "itunes",
            CachedArtworkRecord::default(),
        )
        .unwrap();

        // Simulate legacy cache record on disk without `lastAccessedAt` field for `track::newer`
        let newer_idx = dir
            .path()
            .join("index")
            .join(format!("{}.json", hash_key("track::newer")));
        let mut raw_val: serde_json::Value =
            serde_json::from_slice(&fs::read(&newer_idx).unwrap()).unwrap();
        raw_val.as_object_mut().unwrap().remove("lastAccessedAt");
        fs::write(&newer_idx, serde_json::to_vec(&raw_val).unwrap()).unwrap();

        std::thread::sleep(std::time::Duration::from_millis(10));
        // Touch `track::older` via read_cached_artwork -> updates its last_accessed_at to now
        let touched = read_cached_artwork(dir.path(), "track::older", false)
            .unwrap()
            .unwrap();
        assert!(touched.last_accessed_at >= touched.saved_at);

        // Prune to single entry budget -> `track::newer` (least recently accessed) must be evicted,
        // while `track::older` (recently read) must be preserved!
        let budget = single_bytes + 128;
        prune_cache(dir.path(), budget).unwrap();

        assert!(
            read_cached_artwork(dir.path(), "track::older", false)
                .unwrap()
                .is_some(),
            "recently accessed older entry should survive LRU prune"
        );
        assert!(
            read_cached_artwork(dir.path(), "track::newer", false)
                .unwrap()
                .is_none(),
            "untouched newer entry should be evicted by LRU prune"
        );
        assert!(total_cache_bytes(dir.path()) <= budget);
    }
}
