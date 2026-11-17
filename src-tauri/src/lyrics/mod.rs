use serde::{Deserialize, Serialize};

pub mod cache;
pub mod matching;
pub mod parser;
pub mod providers;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub time_ms: Option<i64>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<Word>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: serde_json::Value,
    pub provider: String,
    pub track_name: Option<String>,
    pub artist_name: Option<String>,
    pub album_name: Option<String>,
    pub duration: Option<f64>,
    #[serde(default)]
    pub instrumental: bool,
    #[serde(default)]
    pub has_word_sync: bool,
    pub plain_lyrics: Option<String>,
    pub synced_lyrics: Option<String>,
    pub lyricsfile: Option<String>,
    #[serde(default)]
    pub lines: Vec<Line>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrackQuery {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: Option<i64>,
}

impl TrackQuery {
    fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() || self.title.trim().is_empty() {
            return Err("Track identity and title are required.".into());
        }
        if [&self.id, &self.title, &self.artist, &self.album]
            .iter()
            .any(|s| s.len() > 2048)
            || self.duration_ms.is_some_and(|ms| ms < 0)
        {
            return Err("Invalid track metadata.".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryRequest {
    pub track: TrackQuery,
    pub providers: Vec<String>,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub offline: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResult {
    pub candidates: Vec<matching::Candidate>,
    pub errors: Vec<String>,
    pub from_cache: bool,
    pub offline: bool,
    pub cache_warning: Option<String>,
}

pub struct LyricsEngine {
    providers: providers::NativeProviders,
    // Serializes cache/read/discovery for identical tracks. Weak entries are
    // pruned so browsing a large library does not retain locks indefinitely.
    flights: tokio::sync::Mutex<
        std::collections::HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>,
    >,
}

impl LyricsEngine {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            providers: providers::NativeProviders::new()?,
            flights: Default::default(),
        })
    }

    pub async fn discover(
        &self,
        cache_dir: std::path::PathBuf,
        mut request: DiscoveryRequest,
    ) -> Result<DiscoveryResult, String> {
        request.track.validate()?;
        request.providers.sort();
        request.providers.dedup();
        if request.providers.is_empty()
            || request
                .providers
                .iter()
                .any(|p| !providers::PROVIDERS.contains(&p.as_str()))
        {
            return Err("Unsupported lyrics provider selection.".into());
        }
        let key = cache::identity(&request.track, &request.providers);
        let lock = {
            let mut flights = self.flights.lock().await;
            flights.retain(|_, lock| lock.strong_count() > 0);
            let lock = flights
                .get(&key)
                .and_then(std::sync::Weak::upgrade)
                .unwrap_or_else(|| std::sync::Arc::new(tokio::sync::Mutex::new(())));
            flights.insert(key.clone(), std::sync::Arc::downgrade(&lock));
            lock
        };
        let _guard = lock.lock().await;
        let fingerprint = cache::fingerprint(&request.track, &request.providers);
        let read_dir = cache_dir.clone();
        let read_key = key.clone();
        let read_fingerprint = fingerprint.clone();
        let cached = tokio::task::spawn_blocking(move || {
            cache::read(&read_dir, &read_key, &read_fingerprint)
        })
        .await
        .map_err(|e| e.to_string())?;
        let mut warning = cached.as_ref().err().cloned();
        let cached = cached.ok().flatten();
        if let Some(entry) = &cached {
            if (!request.force && entry.is_fresh(cache::now_ms()))
                || (request.offline && !entry.result.candidates.is_empty())
            {
                let mut result = entry.result.clone();
                result.from_cache = true;
                result.offline = request.offline;
                result.cache_warning = warning;
                return Ok(result);
            }
        }
        if request.offline {
            return Ok(DiscoveryResult {
                offline: true,
                cache_warning: warning,
                ..Default::default()
            });
        }
        let tasks = request.providers.iter().map(|p| {
            let p = p.clone();
            let track = request.track.clone();
            async move {
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(14),
                    self.providers.fetch(&p, &track),
                )
                .await;
                match result {
                    Ok(Ok(records)) => Ok(records),
                    Ok(Err(e)) => Err(format!("{p}: {e}")),
                    Err(_) => Err(format!("{p}: lyrics lookup timed out.")),
                }
            }
        });
        let mut records = Vec::new();
        let mut errors = Vec::new();
        for result in futures_util::future::join_all(tasks).await {
            match result {
                Ok(found) => records.extend(found),
                Err(e) => errors.push(e),
            }
        }
        let candidates = matching::rank(&request.track, records);
        let mut result = DiscoveryResult {
            candidates,
            errors,
            ..Default::default()
        };
        // A partial failure must never become a durable negative result. Keep
        // previously verified data available when the network is unavailable.
        if result.candidates.is_empty() && !result.errors.is_empty() {
            if let Some(entry) = cached.filter(|e| !e.result.candidates.is_empty()) {
                result.candidates = entry.result.candidates;
                result.from_cache = true;
            }
        } else if result.errors.is_empty() {
            let write_result = result.clone();
            let write_fingerprint = fingerprint.clone();
            let saved = tokio::task::spawn_blocking(move || {
                cache::write(&cache_dir, &key, &write_fingerprint, write_result)
            })
            .await
            .map_err(|e| e.to_string())?;
            if let Err(e) = saved {
                warning = Some(e);
            }
        }
        result.cache_warning = warning;
        Ok(result)
    }
}

#[tauri::command]
pub async fn discover_desktop_lyrics(
    app: tauri::AppHandle,
    engine: tauri::State<'_, LyricsEngine>,
    request: DiscoveryRequest,
) -> Result<DiscoveryResult, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("lyrics-v1");
    engine.discover(dir, request).await
}

#[tauri::command]
pub async fn parse_desktop_lyrics(content: String) -> Result<parser::ParsedLyrics, String> {
    if content.len() > providers::MAX_PAYLOAD_BYTES {
        return Err("Lyrics payload exceeds the 2 MiB limit.".into());
    }
    tokio::task::spawn_blocking(move || parser::parse(&content))
        .await
        .map_err(|e| e.to_string())
}
