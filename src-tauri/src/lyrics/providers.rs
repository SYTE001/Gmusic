use super::{matching, parser, Line, Record, TrackQuery, Word};
use reqwest::{Client, StatusCode, Url};
use serde_json::Value;
use std::{
    collections::HashMap,
    time::{Duration, SystemTime},
};
use tokio::{sync::Mutex, time::Instant};

pub const PROVIDERS: &[&str] = &["lrcmux", "lrclib", "lyricsdb"];
pub const MAX_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;
const BASES: [&str; 3] = [
    "https://api.lrcmux.dev",
    "https://lrclib.net/api",
    "https://lyricsdb.kollod.dev/api",
];

pub struct NativeProviders {
    client: Client,
    gates: HashMap<String, Mutex<Instant>>,
    bases: [String; 3],
    request_timeout: Duration,
}

impl NativeProviders {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .user_agent("Gmusic/1.1.0 (https://github.com/SYTE001/Gmusic)")
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            // Do not follow a provider-controlled redirect to an arbitrary host.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            gates: PROVIDERS
                .iter()
                .map(|p| (p.to_string(), Mutex::new(Instant::now())))
                .collect(),
            bases: BASES.map(String::from),
            request_timeout: Duration::from_secs(10),
        })
    }

    #[cfg(test)]
    pub fn with_test_endpoints(bases: [String; 3], request_timeout: Duration) -> Self {
        let mut providers = Self::new().unwrap();
        providers.bases = bases;
        providers.request_timeout = request_timeout;
        providers
    }

    fn url(&self, provider: &str, path: &str, params: &[(&str, String)]) -> Result<Url, String> {
        let i = PROVIDERS
            .iter()
            .position(|p| *p == provider)
            .ok_or("Unknown provider.")?;
        let mut url =
            Url::parse(&format!("{}{}", self.bases[i], path)).map_err(|e| e.to_string())?;
        for (k, v) in params {
            if !v.is_empty() {
                url.query_pairs_mut().append_pair(k, v);
            }
        }
        Ok(url)
    }

    async fn request(
        &self,
        provider: &str,
        path: &str,
        params: &[(&str, String)],
    ) -> Result<Option<Value>, String> {
        let url = self.url(provider, path, params)?;
        let gate = self.gates.get(provider).ok_or("Unknown provider.")?;
        // Lock spans the complete request and body, not just dispatch: requests
        // to the same provider never overlap, even across tracks/windows.
        let mut next = gate.lock().await;
        let gap = Duration::from_millis(if provider == "lyricsdb" { 200 } else { 300 });
        for attempt in 0..2 {
            tokio::time::sleep_until(*next).await;
            *next = Instant::now() + gap;
            let response = tokio::time::timeout(self.request_timeout, async {
                let mut response = self
                    .client
                    .get(url.clone())
                    .header("Accept", "application/json")
                    .send()
                    .await
                    .map_err(|e| {
                        if e.is_timeout() {
                            "request timed out".to_string()
                        } else {
                            "network request failed".to_string()
                        }
                    })?;
                let status = response.status();
                if status == StatusCode::TOO_MANY_REQUESTS {
                    let delay = response
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .map(retry_after)
                        .unwrap_or(Duration::from_secs(30));
                    *next = Instant::now() + delay.max(gap);
                    return Err("rate-limited; Retry-After cooldown is active".to_string());
                }
                if status == StatusCode::NOT_FOUND {
                    return Ok(None);
                }
                if !status.is_success() {
                    return Err(format!("HTTP {}", status.as_u16()));
                }
                if response
                    .content_length()
                    .is_some_and(|len| len > MAX_PAYLOAD_BYTES as u64)
                {
                    return Err("payload exceeds 2 MiB limit".into());
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| "could not read provider response")?
                {
                    if bytes.len() + chunk.len() > MAX_PAYLOAD_BYTES {
                        return Err("payload exceeds 2 MiB limit".into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                serde_json::from_slice(&bytes)
                    .map(Some)
                    .map_err(|_| "malformed JSON response".to_string())
            })
            .await
            .unwrap_or_else(|_| Err("request timed out".into()));
            *next = (*next).max(Instant::now() + gap);
            match response {
                Err(ref error)
                    if attempt == 0
                        && (error.starts_with("HTTP 5") || error == "network request failed") =>
                {
                    *next = (*next).max(Instant::now() + Duration::from_millis(500));
                }
                result => return result,
            }
        }
        Err("provider request failed".into())
    }

    pub async fn fetch(&self, provider: &str, track: &TrackQuery) -> Result<Vec<Record>, String> {
        if provider == "lyricsdb" {
            return self.lyricsdb(track).await;
        }
        let native = provider == "lrcmux";
        let exact_path = "/get";
        let mut params = vec![
            (
                if native { "title" } else { "track_name" },
                track.title.clone(),
            ),
            (
                if native { "artist" } else { "artist_name" },
                track.artist.clone(),
            ),
            (
                if native { "album" } else { "album_name" },
                track.album.clone(),
            ),
        ];
        if let Some(duration) = track.duration_ms.filter(|d| *d > 0) {
            params.push((
                "duration",
                ((duration as f64 / 1000.0).round() as i64).to_string(),
            ));
        }
        if native {
            params.extend([("level", "word".into()), ("format", "json".into())]);
        }
        let mut records = Vec::new();
        let mut last_error = None;
        if !track.artist.is_empty() {
            match self.request(provider, exact_path, &params).await {
                Ok(Some(data)) => match if native {
                    map_lrcmux(&data)
                } else {
                    map_compat(&data, provider)
                } {
                    Ok(mut record) => {
                        parser::normalize_record(&mut record);
                        let complete = matching::is_safe_match(track, &record)
                            && matches!(parser::capability(&record), "line" | "word");
                        records.push(record);
                        if complete {
                            return Ok(records);
                        }
                    }
                    Err(e) => last_error = Some(e),
                },
                Ok(None) => (),
                Err(e) => {
                    if e.starts_with("rate-limited") {
                        return Err(e);
                    }
                    last_error = Some(e);
                }
            }
        }
        let path = if native {
            "/compat/lrclib/api/search"
        } else {
            "/search"
        };
        // A maximum of two distinct search queries. First structured metadata,
        // then title-only for catalogues with inconsistent artist credits.
        for artist in [track.artist.as_str(), ""] {
            if artist.is_empty() && track.artist.is_empty() && last_error.is_some() {
                break;
            }
            let params = vec![
                ("track_name", track.title.clone()),
                ("artist_name", artist.into()),
            ];
            match self.request(provider, path, &params).await {
                Ok(Some(data)) => {
                    let Some(items) = data.as_array() else {
                        last_error = Some("malformed search response".into());
                        continue;
                    };
                    let mut malformed = false;
                    for item in items.iter().take(30) {
                        match map_compat(item, provider) {
                            Ok(mut record) => {
                                parser::normalize_record(&mut record);
                                records.push(record);
                            }
                            Err(_) => malformed = true,
                        }
                    }
                    if !items.is_empty() && records.is_empty() && malformed {
                        last_error = Some("malformed candidate records".into());
                    }
                    if !records.is_empty() {
                        return Ok(records);
                    }
                }
                Ok(None) => (),
                Err(e) => {
                    if e.starts_with("rate-limited") {
                        return Err(e);
                    }
                    last_error = Some(e);
                }
            }
            if track.artist.is_empty() {
                break;
            }
        }
        if records.is_empty() {
            if let Some(e) = last_error {
                return Err(e);
            }
        }
        Ok(records)
    }

    async fn lyricsdb(&self, track: &TrackQuery) -> Result<Vec<Record>, String> {
        let data = self
            .request(
                "lyricsdb",
                "/tracks/search",
                &[("q", track.title.clone()), ("limit", "10".into())],
            )
            .await?;
        let Some(data) = data else {
            return Ok(Vec::new());
        };
        let items = data
            .as_array()
            .ok_or("malformed LyricsDB search response")?;
        let mut metadata = Vec::new();
        for item in items.iter().take(10) {
            if item.get("hasLyrics").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let Some(id) = item.get("id").and_then(Value::as_str).filter(|s| {
                !s.is_empty()
                    && s.len() <= 128
                    && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            }) else {
                continue;
            };
            let Some(title) = text(item, "title") else {
                continue;
            };
            let artists = item.get("artists").and_then(Value::as_array).map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            });
            let record = Record {
                id: Value::String(id.into()),
                provider: "lyricsdb".into(),
                track_name: Some(title),
                artist_name: artists,
                album_name: text(item, "album"),
                duration: item
                    .get("durationMs")
                    .and_then(Value::as_f64)
                    .map(|ms| ms / 1000.0),
                source: Some("lyricsdb".into()),
                ..Default::default()
            };
            let quality = matching::evaluate(track, &record);
            if !quality.rejected && quality.title_similarity >= 0.55 {
                metadata.push((quality.score, record));
            }
        }
        metadata.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut records = Vec::new();
        let mut last_error = None;
        for (_, mut record) in metadata.into_iter().take(3) {
            let path = format!("/tracks/{}/lyrics", record.id.as_str().unwrap());
            match self
                .request("lyricsdb", &path, &[("format", "json".into())])
                .await
            {
                Ok(Some(data)) => match map_lyricsdb_payload(&data) {
                    Ok(lines) => {
                        record.lines = lines;
                        parser::normalize_record(&mut record);
                        records.push(record);
                    }
                    Err(e) => last_error = Some(e),
                },
                Ok(None) => (),
                Err(e) => {
                    if e.starts_with("rate-limited") {
                        return Err(e);
                    }
                    last_error = Some(e);
                }
            }
        }
        if records.is_empty() {
            if let Some(e) = last_error {
                return Err(e);
            }
        }
        Ok(records)
    }
}

fn retry_after(value: &str) -> Duration {
    value
        .parse::<u64>()
        .map(Duration::from_secs)
        .ok()
        .or_else(|| {
            httpdate::parse_http_date(value)
                .ok()
                .map(|t| t.duration_since(SystemTime::now()).unwrap_or_default())
        })
        .unwrap_or(Duration::from_secs(30))
        .min(Duration::from_secs(24 * 60 * 60))
}
fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
}
fn ms(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).filter(|n| *n >= 0)
}

fn map_compat(value: &Value, provider: &str) -> Result<Record, String> {
    let id = value
        .get("id")
        .filter(|v| v.is_string() || v.is_number())
        .ok_or("missing record id")?
        .clone();
    let title = text(value, "trackName")
        .or_else(|| text(value, "name"))
        .ok_or("missing record title")?;
    Ok(Record {
        id,
        provider: provider.into(),
        track_name: Some(title),
        artist_name: text(value, "artistName"),
        album_name: text(value, "albumName"),
        duration: value.get("duration").and_then(Value::as_f64),
        instrumental: value
            .get("instrumental")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        plain_lyrics: text(value, "plainLyrics"),
        synced_lyrics: text(value, "syncedLyrics"),
        lyricsfile: text(value, "lyricsfile"),
        source: Some(provider.into()),
        ..Default::default()
    })
}

fn map_lrcmux(value: &Value) -> Result<Record, String> {
    let track = value.get("track").ok_or("missing lrcmux track")?;
    let meta = value
        .get("meta")
        .filter(|m| m.is_object())
        .ok_or("missing lrcmux metadata")?;
    let title = text(track, "title").ok_or("missing lrcmux title")?;
    let mut record = Record {
        id: track.get("isrc").cloned().unwrap_or(Value::String(format!(
            "{}-{title}",
            text(track, "artist").unwrap_or_default()
        ))),
        provider: "lrcmux".into(),
        track_name: Some(title),
        artist_name: text(track, "artist"),
        album_name: text(track, "album"),
        duration: track.get("duration").and_then(Value::as_f64),
        instrumental: meta
            .get("instrumental")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        source: meta
            .get("source")
            .and_then(|s| text(s, "name").or_else(|| text(s, "id"))),
        ..Default::default()
    };
    if let Some(lines) = value.get("lines").and_then(Value::as_array) {
        for raw in lines.iter().take(20_000) {
            let Some(text) = raw.get("text").and_then(Value::as_str) else {
                continue;
            };
            let time_ms = ms(raw.get("start"));
            let words = raw
                .get("words")
                .and_then(Value::as_array)
                .map(|ws| {
                    ws.iter()
                        .filter_map(|w| {
                            Some(Word {
                                text: w.get("text")?.as_str()?.into(),
                                start_ms: ms(w.get("start"))?,
                                end_ms: ms(w.get("end")),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            record.lines.push(Line {
                text: text.into(),
                time_ms,
                words,
            });
        }
    }
    Ok(record)
}

fn map_lyricsdb_payload(data: &Value) -> Result<Vec<Line>, String> {
    if let Some(plain) = data.get("plain").and_then(Value::as_str) {
        return Ok(plain
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| Line {
                text: l.into(),
                ..Default::default()
            })
            .collect());
    }
    let rows = data.as_array().ok_or("malformed LyricsDB lyrics payload")?;
    let mut lines = Vec::new();
    for row in rows.iter().take(20_000) {
        let Some(items) = row.as_array() else {
            continue;
        };
        let words: Vec<_> = items
            .iter()
            .filter_map(|v| {
                let t = v.as_array()?;
                let start = ms(t.get(1))?;
                let length = ms(t.get(2));
                let text = t.get(3)?.as_str()?;
                Some(Word {
                    text: text.into(),
                    start_ms: start,
                    end_ms: length.filter(|n| *n > 0).and_then(|n| start.checked_add(n)),
                })
            })
            .collect();
        if !words.is_empty() {
            lines.push(Line {
                time_ms: Some(words[0].start_ms),
                text: words.iter().map(|w| w.text.as_str()).collect(),
                words,
            });
        } else {
            let text = items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" ");
            if !text.trim().is_empty() {
                lines.push(Line {
                    text,
                    ..Default::default()
                });
            }
        }
    }
    if lines.is_empty() && !rows.is_empty() {
        return Err("malformed LyricsDB lyric rows".into());
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    async fn server(
        status: &str,
        body: &str,
        delay: Duration,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0; 4096];
            let _ = stream.read(&mut buf).await;
            tokio::time::sleep(delay).await;
            let _ = stream.write_all(reply.as_bytes()).await;
        });
        (format!("http://{addr}"), handle)
    }
    #[tokio::test]
    async fn timeout_and_failure_are_errors_not_missing() {
        let mut providers = NativeProviders::new().unwrap();
        let (url, task) = server("200 OK", "{}", Duration::from_millis(100)).await;
        providers.bases[0] = url;
        providers.request_timeout = Duration::from_millis(10);
        assert!(providers
            .request("lrcmux", "/get", &[])
            .await
            .unwrap_err()
            .contains("timed out"));
        task.abort();
        let (url, task) = server("403 Forbidden", "{}", Duration::ZERO).await;
        providers.bases[1] = url;
        providers.request_timeout = Duration::from_secs(2);
        assert_eq!(
            providers.request("lrclib", "/get", &[]).await.unwrap_err(),
            "HTTP 403"
        );
        task.await.unwrap();
    }
    #[tokio::test]
    async fn missing_and_malformed_and_rate_limit() {
        let mut p = NativeProviders::new().unwrap();
        let (url, task) = server("404 Not Found", "{}", Duration::ZERO).await;
        p.bases[0] = url;
        assert!(p.request("lrcmux", "/get", &[]).await.unwrap().is_none());
        task.await.unwrap();
        let (url, task) = server("200 OK", "broken", Duration::ZERO).await;
        p.bases[1] = url;
        assert!(p
            .request("lrclib", "/get", &[])
            .await
            .unwrap_err()
            .contains("malformed"));
        task.await.unwrap();
        let (url, task) = server(
            "429 Too Many Requests\r\nRetry-After: 60",
            "{}",
            Duration::ZERO,
        )
        .await;
        p.bases[2] = url;
        assert!(p
            .request("lyricsdb", "/get", &[])
            .await
            .unwrap_err()
            .contains("rate-limited"));
        task.await.unwrap();
        assert!(*p.gates["lyricsdb"].lock().await > Instant::now() + Duration::from_secs(59));
    }
    #[test]
    fn established_provider_payloads_preserve_word_milliseconds() {
        let raw = serde_json::json!([[[0, 1000, 500, "hello "], [0, 1500, 500, "world"]]]);
        let lines = map_lyricsdb_payload(&raw).unwrap();
        assert_eq!(lines[0].words[1].end_ms, Some(2000));
        let raw = serde_json::json!({"track":{"title":"Song","artist":"Artist","duration":200},"meta":{"level":"word"},"lines":[{"text":"hello","start":1000}]});
        let mut record = map_lrcmux(&raw).unwrap();
        parser::normalize_record(&mut record);
        assert!(!record.has_word_sync);
        assert_eq!(parser::capability(&record), "line");
        assert!(map_compat(&serde_json::json!({"id":1}), "lrclib").is_err());
    }
}
