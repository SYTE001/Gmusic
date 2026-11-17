use super::{DiscoveryResult, TrackQuery};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

const VERSION: u32 = 1;
const POSITIVE_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS: u64 = 60 * 60 * 1000;
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
pub struct Entry {
    version: u32,
    identity: String,
    fingerprint: String,
    saved_at: u64,
    pub result: DiscoveryResult,
}

impl Entry {
    pub fn is_fresh(&self, now: u64) -> bool {
        let ttl = if self.result.candidates.is_empty() {
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

pub fn fingerprint(track: &TrackQuery, providers: &[String]) -> String {
    // Metadata and provider changes invalidate the per-track cache entry.
    let mut providers = providers.to_vec();
    providers.sort();
    providers.dedup();
    let payload = serde_json::to_vec(&(VERSION, track, providers)).expect("serializable identity");
    format!("{:x}", Sha256::digest(payload))
}

pub fn identity(track: &TrackQuery, _providers: &[String]) -> String {
    // Stable identifiers avoid leaving an obsolete cache file for every metadata edit.
    format!("{:x}", Sha256::digest(track.id.as_bytes()))
}

pub fn read(dir: &Path, key: &str, expected_fingerprint: &str) -> Result<Option<Entry>, String> {
    let path = dir.join(format!("{key}.json"));
    let metadata = match fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not inspect lyrics cache: {e}")),
    };
    if metadata.len() > MAX_ENTRY_BYTES {
        return Err("Lyrics cache entry exceeds size limit.".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("Could not read lyrics cache: {e}"))?;
    let entry: Entry =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid lyrics cache: {e}"))?;
    if entry.version != VERSION
        || entry.identity != key
        || entry.fingerprint != expected_fingerprint
    {
        return Ok(None);
    }
    if entry.result.candidates.len() > 12 || !entry.result.errors.is_empty() {
        return Err("Invalid lyrics cache contents.".into());
    }
    Ok(Some(entry))
}

pub fn write(
    dir: &Path,
    key: &str,
    expected_fingerprint: &str,
    result: DiscoveryResult,
) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create lyrics cache: {e}"))?;
    let entry = Entry {
        version: VERSION,
        identity: key.into(),
        fingerprint: expected_fingerprint.into(),
        saved_at: now_ms(),
        result,
    };
    let bytes = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_ENTRY_BYTES {
        return Err("Lyrics cache entry exceeds size limit.".into());
    }
    // Same-directory atomic replacement works on Windows too. A failed write
    // never truncates the previous verified entry.
    let mut temp = tempfile::NamedTempFile::new_in(dir)
        .map_err(|e| format!("Could not write lyrics cache: {e}"))?;
    temp.write_all(&bytes)
        .and_then(|()| temp.as_file().sync_all())
        .map_err(|e| format!("Could not flush lyrics cache: {e}"))?;
    temp.persist(dir.join(format!("{key}.json")))
        .map_err(|e| format!("Could not replace lyrics cache: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track() -> TrackQuery {
        TrackQuery {
            id: "stable-id".into(),
            title: "Song".into(),
            artist: "Artist".into(),
            album: String::new(),
            duration_ms: Some(200000),
        }
    }

    #[test]
    fn stable_key_invalidates_metadata_duration_and_provider_changes() {
        let providers = vec!["lrclib".into()];
        let key = identity(&track(), &providers);
        let original = fingerprint(&track(), &providers);
        let mut changed = track();
        changed.title = "Edited".into();
        assert_eq!(key, identity(&changed, &providers));
        assert_ne!(original, fingerprint(&changed, &providers));
        changed = track();
        changed.duration_ms = Some(202000);
        assert_ne!(original, fingerprint(&changed, &providers));
        assert_ne!(original, fingerprint(&track(), &["lrcmux".into()]));
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &key, &original, DiscoveryResult::default()).unwrap();
        assert!(read(dir.path(), &key, &fingerprint(&changed, &providers))
            .unwrap()
            .is_none());
    }

    #[test]
    fn disk_roundtrip_negative_ttl_version_and_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let key = identity(&track(), &[]);
        let expected = fingerprint(&track(), &[]);
        write(dir.path(), &key, &expected, DiscoveryResult::default()).unwrap();
        let entry = read(dir.path(), &key, &expected).unwrap().unwrap();
        assert!(entry.is_fresh(entry.saved_at));
        assert!(!entry.is_fresh(entry.saved_at + NEGATIVE_TTL_MS));
        assert!(!entry.is_fresh(entry.saved_at - 1));
        let mut entry = entry;
        entry.version = 0;
        fs::write(
            dir.path().join(format!("{key}.json")),
            serde_json::to_vec(&entry).unwrap(),
        )
        .unwrap();
        assert!(read(dir.path(), &key, &expected).unwrap().is_none());
        fs::write(dir.path().join(format!("{key}.json")), b"{broken").unwrap();
        assert!(read(dir.path(), &key, &expected).is_err());
    }

    #[test]
    fn stale_positive_cache_and_failed_replacement_are_recoverable() {
        let dir = tempfile::tempdir().unwrap();
        let track = track();
        let key = identity(&track, &[]);
        let expected = fingerprint(&track, &[]);
        let record = super::super::Record {
            id: 1.into(),
            provider: "lrclib".into(),
            track_name: Some(track.title.clone()),
            artist_name: Some(track.artist.clone()),
            duration: Some(200.0),
            synced_lyrics: Some("[00:01]Hello".into()),
            ..Default::default()
        };
        let result = DiscoveryResult {
            candidates: super::super::matching::rank(&track, vec![record]),
            ..Default::default()
        };
        write(dir.path(), &key, &expected, result).unwrap();
        let entry = read(dir.path(), &key, &expected).unwrap().unwrap();
        assert!(!entry.is_fresh(entry.saved_at + POSITIVE_TTL_MS));
        assert_eq!(entry.result.candidates.len(), 1);
        let mut too_large = entry.result.clone();
        too_large.candidates[0].record.lines[0].text = "x".repeat(MAX_ENTRY_BYTES as usize);
        assert!(write(dir.path(), &key, &expected, too_large).is_err());
        assert_eq!(
            read(dir.path(), &key, &expected)
                .unwrap()
                .unwrap()
                .result
                .candidates[0]
                .record
                .lines[0]
                .text,
            "Hello"
        );
    }

    #[test]
    fn atomic_replacement_preserves_valid_entries() {
        let dir = tempfile::tempdir().unwrap();
        let key = identity(&track(), &[]);
        let expected = fingerprint(&track(), &[]);
        write(dir.path(), &key, &expected, DiscoveryResult::default()).unwrap();
        write(dir.path(), &key, &expected, DiscoveryResult::default()).unwrap();
        assert!(read(dir.path(), &key, &expected).unwrap().is_some());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
