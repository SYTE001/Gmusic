use crate::lyrics::{Line, Word};
use serde::{Deserialize, Serialize};

pub const MAX_BATCH_SIZE: usize = 500;
pub const MAX_STRING_LEN: usize = 4096;
pub const MAX_LYRICS_LINES: usize = 20_000;
pub const MAX_AUDIO_BLOB_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrokenInfoDto {
    pub is_broken: bool,
    pub category: String,
    pub description: String,
    pub failed_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackDto {
    pub id: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album: String,
    pub track_number: Option<i64>,
    pub album_track_count: Option<i64>,
    pub duration_ms: Option<i64>,
    pub file_name: String,
    #[serde(default)]
    pub file_size: i64,
    #[serde(default)]
    pub mime_type: String,
    pub added_at: i64,
    pub last_played_at: Option<i64>,
    #[serde(default)]
    pub play_count: i64,
    #[serde(default)]
    pub is_liked: bool,
    pub availability: String,
    pub access_mode: String,
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub metadata_from_filename: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broken: Option<BrokenInfoDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desktop_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artwork_object_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<i64>,
}

impl TrackDto {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() || self.id.len() > 256 {
            return Err("Invalid track ID.".into());
        }
        if self.title.trim().is_empty() || self.title.len() > MAX_STRING_LEN {
            return Err("Invalid track title.".into());
        }
        if self.file_name.trim().is_empty() || self.file_name.len() > MAX_STRING_LEN {
            return Err("Invalid track fileName.".into());
        }
        if self.artist.len() > MAX_STRING_LEN || self.album.len() > MAX_STRING_LEN {
            return Err("Track artist or album exceeds maximum length.".into());
        }
        if self.file_size < 0 || self.play_count < 0 {
            return Err("Track fileSize and playCount must be non-negative.".into());
        }
        if let Some(d) = self.duration_ms {
            if d < 0 {
                return Err("Track durationMs must be non-negative.".into());
            }
        }
        if !matches!(
            self.availability.as_str(),
            "available" | "permission-required" | "missing" | "unsupported" | "broken" | "offline"
        ) {
            return Err(format!(
                "Unsupported track availability: {}",
                self.availability
            ));
        }
        if !matches!(
            self.access_mode.as_str(),
            "handle" | "stored-copy" | "session-only" | "cloud" | "desktop-path"
        ) {
            return Err(format!(
                "Unsupported track accessMode: {}",
                self.access_mode
            ));
        }
        if let Some(ref desc) = self.description {
            if desc.len() > 16384 {
                return Err("Track description exceeds maximum length.".into());
            }
        }
        if let Some(ref p) = self.desktop_path {
            if p.len() > MAX_STRING_LEN {
                return Err("Track desktopPath exceeds maximum length.".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistDto {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub track_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl PlaylistDto {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() || self.id.len() > 256 {
            return Err("Invalid playlist ID.".into());
        }
        if self.name.trim().is_empty() || self.name.len() > MAX_STRING_LEN {
            return Err("Invalid playlist name.".into());
        }
        if self.description.len() > 16384 {
            return Err("Playlist description exceeds maximum length.".into());
        }
        if self.track_ids.len() > 50_000
            || self
                .track_ids
                .iter()
                .any(|id| id.trim().is_empty() || id.len() > 256)
        {
            return Err("Invalid playlist trackIds.".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LyricOriginDto {
    pub kind: String,
    pub record_id: serde_json::Value,
    pub fetched_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_album: Option<String>,
    pub capability: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrackLyricsDto {
    pub track_id: String,
    pub format: String,
    #[serde(default)]
    pub lines: Vec<Line>,
    #[serde(default)]
    pub offset_ms: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub skipped_lines: i64,
    pub source_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<LyricOriginDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<i64>,
}

impl TrackLyricsDto {
    pub fn validate(&self) -> Result<(), String> {
        if self.track_id.trim().is_empty() || self.track_id.len() > 256 {
            return Err("Invalid lyrics trackId.".into());
        }
        if !matches!(self.format.as_str(), "lrc" | "txt") {
            return Err(format!("Unsupported lyrics format: {}", self.format));
        }
        if self.lines.len() > MAX_LYRICS_LINES {
            return Err("Lyrics line count exceeds limit.".into());
        }
        if self.skipped_lines < 0 {
            return Err("Lyrics skippedLines must be non-negative.".into());
        }
        if self.source_name.len() > MAX_STRING_LEN {
            return Err("Lyrics sourceName exceeds maximum length.".into());
        }
        for line in &self.lines {
            if let Some(t) = line.time_ms {
                if t < 0 {
                    return Err("Lyric line timeMs must be non-negative.".into());
                }
            }
            for Word {
                start_ms, end_ms, ..
            } in &line.words
            {
                if *start_ms < 0 {
                    return Err("Lyric word startMs must be non-negative.".into());
                }
                if let Some(end) = end_ms {
                    if *end < *start_ms {
                        return Err("Lyric word endMs cannot precede startMs.".into());
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LyricsCacheMetaDto {
    pub track_id: String,
    pub status: String,
    pub checked_at: i64,
    pub record_id: Option<i64>,
    pub schema_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovery_identity: Option<String>,
}

impl LyricsCacheMetaDto {
    pub fn validate(&self) -> Result<(), String> {
        if self.track_id.trim().is_empty() || self.track_id.len() > 256 {
            return Err("Invalid lyricsMeta trackId.".into());
        }
        if !matches!(
            self.status.as_str(),
            "accepted" | "not-found" | "needs-selection"
        ) {
            return Err(format!("Unsupported lyricsMeta status: {}", self.status));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrefEntryDto {
    pub name: String,
    pub payload: serde_json::Value,
}

impl PrefEntryDto {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() || self.name.len() > 128 {
            return Err("Invalid preference key name.".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkMigrationEntryDto {
    pub track_id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioMigrationEntryDto {
    pub track_id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceStatusDto {
    pub authority: String,
    pub schema_version: i32,
    pub integrity_ok: bool,
    pub integrity_errors: Vec<String>,
    pub track_count: i64,
    pub playlist_count: i64,
    pub lyrics_count: i64,
    pub lyrics_meta_count: i64,
    pub prefs_count: i64,
    pub artwork_count: i64,
    pub audio_count: i64,
    pub migration_id: Option<String>,
    pub last_error: Option<String>,
    pub recovery_guidance: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationBeginRequest {
    pub migration_id: String,
    pub expected_tracks: i64,
    pub expected_playlists: i64,
    pub expected_lyrics: i64,
    pub expected_lyrics_meta: i64,
    pub expected_prefs: i64,
    pub expected_artwork: i64,
    pub expected_audio: i64,
    pub expected_checksum: String,
    #[serde(default)]
    pub force_reimport: bool,
}

impl MigrationBeginRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.migration_id.trim().is_empty() || self.migration_id.len() > 128 {
            return Err("Invalid migrationId.".into());
        }
        if self.expected_tracks < 0
            || self.expected_playlists < 0
            || self.expected_lyrics < 0
            || self.expected_lyrics_meta < 0
            || self.expected_prefs < 0
            || self.expected_artwork < 0
            || self.expected_audio < 0
        {
            return Err("Expected migration counts cannot be negative.".into());
        }
        if self.expected_checksum.trim().is_empty() || self.expected_checksum.len() > 256 {
            return Err("Invalid expectedChecksum.".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationBatchRequest {
    pub migration_id: String,
    #[serde(default)]
    pub tracks: Vec<TrackDto>,
    #[serde(default)]
    pub playlists: Vec<PlaylistDto>,
    #[serde(default)]
    pub lyrics: Vec<TrackLyricsDto>,
    #[serde(default)]
    pub lyrics_meta: Vec<LyricsCacheMetaDto>,
    #[serde(default)]
    pub prefs: Vec<PrefEntryDto>,
    #[serde(default)]
    pub artwork: Vec<ArtworkMigrationEntryDto>,
    #[serde(default)]
    pub audio: Vec<AudioMigrationEntryDto>,
}

impl MigrationBatchRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.migration_id.trim().is_empty() || self.migration_id.len() > 128 {
            return Err("Invalid migrationId.".into());
        }
        if self.tracks.len() > MAX_BATCH_SIZE
            || self.playlists.len() > MAX_BATCH_SIZE
            || self.lyrics.len() > MAX_BATCH_SIZE
            || self.lyrics_meta.len() > MAX_BATCH_SIZE
            || self.prefs.len() > MAX_BATCH_SIZE
            || self.artwork.len() > MAX_BATCH_SIZE
            || self.audio.len() > MAX_BATCH_SIZE
        {
            return Err("Migration batch size exceeds maximum allowed limit.".into());
        }
        for t in &self.tracks {
            t.validate()?;
        }
        for p in &self.playlists {
            p.validate()?;
        }
        for l in &self.lyrics {
            l.validate()?;
        }
        for m in &self.lyrics_meta {
            m.validate()?;
        }
        for pref in &self.prefs {
            pref.validate()?;
        }
        for art in &self.artwork {
            if art.track_id.trim().is_empty() || art.track_id.len() > 256 {
                return Err("Invalid artwork trackId in migration batch.".into());
            }
            if art.bytes.is_empty() {
                return Err("Artwork bytes in migration batch cannot be empty.".into());
            }
            if let Some(ref expected) = art.sha256 {
                use sha2::{Digest, Sha256};
                let actual = format!("{:x}", Sha256::digest(&art.bytes));
                if !actual.eq_ignore_ascii_case(expected) {
                    return Err(format!(
                        "Artwork SHA-256 mismatch for track {} (expected {expected}, got {actual}).",
                        art.track_id
                    ));
                }
            }
        }
        for aud in &self.audio {
            if aud.track_id.trim().is_empty() || aud.track_id.len() > 256 {
                return Err("Invalid audio trackId in migration batch.".into());
            }
            if aud.bytes.is_empty() {
                return Err("Audio bytes in migration batch cannot be empty.".into());
            }
            if aud.bytes.len() > MAX_AUDIO_BLOB_BYTES {
                return Err("Audio blob exceeds maximum allowed size.".into());
            }
            if let Some(ref expected) = aud.sha256 {
                use sha2::{Digest, Sha256};
                let actual = format!("{:x}", Sha256::digest(&aud.bytes));
                if !actual.eq_ignore_ascii_case(expected) {
                    return Err(format!(
                        "Audio SHA-256 mismatch for track {} (expected {expected}, got {actual}).",
                        aud.track_id
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceLibraryRequest {
    pub tracks: Vec<TrackDto>,
    pub playlists: Vec<PlaylistDto>,
    pub lyrics: Vec<TrackLyricsDto>,
    pub preferences: Option<serde_json::Value>,
}

impl ReplaceLibraryRequest {
    pub fn validate(&self) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        for t in &self.tracks {
            t.validate()?;
            if !seen.insert(&t.id) {
                return Err(format!("Duplicate track ID in replaceLibrary: {}", t.id));
            }
        }
        for p in &self.playlists {
            p.validate()?;
        }
        for l in &self.lyrics {
            l.validate()?;
        }
        Ok(())
    }
}
