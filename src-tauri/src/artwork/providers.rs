use super::matching::{
    extract_primary_artist, has_meaningful_album, is_placeholder_artist, is_valid_mbid,
    normalize_core_title, normalize_for_matching, normalize_metadata_query, rank_itunes_albums,
    rank_itunes_songs, score_release, score_release_group, ArtworkQuery, ItunesCandidateInput,
    MbReleaseGroup, MbReleaseSummary, ScoredMbCandidate,
};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, SystemTime};
use tokio::sync::Mutex;
use tokio::time::Instant;

pub const GMUSIC_USER_AGENT: &str = "Gmusic/1.1.0 ( https://github.com/SYTE001/Gmusic )";
const MAX_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

const ALLOWED_ARTWORK_HOSTS: &[&str] = &["coverartarchive.org", "archive.org", "mzstatic.com"];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDiscoveryResult {
    pub url: Option<String>,
    pub source: String,
    pub release_group_mbid: Option<String>,
    pub release_mbid: Option<String>,
    pub confidence: u32,
    pub album: Option<String>,
    pub artist: Option<String>,
    pub transient_failure: bool,
    pub failed_http_requests: u32,
}

pub fn is_valid_artwork_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    let Ok(parsed) = Url::parse(trimmed) else {
        return false;
    };
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return false;
    }
    let Some(host) = parsed.host_str().map(|h| h.to_ascii_lowercase()) else {
        return false;
    };
    if host == "127.0.0.1" || host == "localhost" {
        return cfg!(test);
    }
    ALLOWED_ARTWORK_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

pub fn sanitize_artwork_url(raw: &str) -> Option<String> {
    if !is_valid_artwork_url(raw) {
        return None;
    }
    let mut parsed = Url::parse(raw.trim()).ok()?;
    let is_local = parsed
        .host_str()
        .is_some_and(|h| h == "127.0.0.1" || h == "localhost");
    if parsed.scheme() == "http" && !is_local {
        let _ = parsed.set_scheme("https");
    }
    Some(parsed.to_string())
}

fn parse_retry_after(value: &str) -> Duration {
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
        .min(Duration::from_secs(3600))
}

#[derive(Debug, Clone)]
enum FetchJsonOutcome {
    Ok(Value),
    NotFound,
    TransientError(u32),
}

pub struct NativeArtworkProviders {
    client: Client,
    image_client: Client,
    gates: HashMap<String, Mutex<Instant>>,
    mb_base: String,
    caa_base: String,
    itunes_base: String,
    mb_gap: Duration,
    caa_gap: Duration,
    itunes_gap: Duration,
    timeout: Duration,
}

impl NativeArtworkProviders {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .user_agent(GMUSIC_USER_AGENT)
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;

        // CAA and Archive.org serve cover art via 307/302 redirects to archive.org CDN nodes;
        // validate every redirect target against ALLOWED_ARTWORK_HOSTS.
        let image_client = Client::builder()
            .user_agent(GMUSIC_USER_AGENT)
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.error("too many redirects");
                }
                let url_str = attempt.url().as_str();
                if is_valid_artwork_url(url_str) {
                    attempt.follow()
                } else {
                    attempt.error("redirect to untrusted host blocked")
                }
            }))
            .build()
            .map_err(|e| e.to_string())?;

        let mut gates = HashMap::new();
        gates.insert("mb".into(), Mutex::new(Instant::now()));
        gates.insert("caa".into(), Mutex::new(Instant::now()));
        gates.insert("itunes".into(), Mutex::new(Instant::now()));

        Ok(Self {
            client,
            image_client,
            gates,
            mb_base: "https://musicbrainz.org/ws/2".into(),
            caa_base: "https://coverartarchive.org".into(),
            itunes_base: "https://itunes.apple.com".into(),
            mb_gap: Duration::from_millis(1000),
            caa_gap: Duration::from_millis(150),
            itunes_gap: Duration::from_millis(350),
            timeout: Duration::from_secs(10),
        })
    }

    #[cfg(test)]
    pub fn with_test_endpoints(mb: String, caa: String, itunes: String) -> Self {
        let mut s = Self::new().unwrap();
        s.mb_base = mb;
        s.caa_base = caa;
        s.itunes_base = itunes;
        s.mb_gap = Duration::ZERO;
        s.caa_gap = Duration::ZERO;
        s.itunes_gap = Duration::ZERO;
        s.timeout = Duration::from_secs(2);
        s
    }

    async fn fetch_json(&self, gate_key: &str, gap: Duration, url: Url) -> FetchJsonOutcome {
        let Some(gate) = self.gates.get(gate_key) else {
            return FetchJsonOutcome::TransientError(1);
        };
        let mut next = gate.lock().await;
        let mut failed_requests = 0u32;

        for attempt in 0..2 {
            tokio::time::sleep_until(*next).await;
            *next = Instant::now() + gap;

            let req = self
                .client
                .get(url.clone())
                .header("Accept", "application/json");
            let res = tokio::time::timeout(self.timeout, async {
                let mut resp = req.send().await.map_err(|_| false)?;
                let status = resp.status();
                if status == StatusCode::NOT_FOUND {
                    return Ok(FetchJsonOutcome::NotFound);
                }
                if status == StatusCode::TOO_MANY_REQUESTS {
                    let delay = resp
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok())
                        .map(parse_retry_after)
                        .unwrap_or(Duration::from_secs(30));
                    *next = Instant::now() + delay.max(gap);
                    return Err(true);
                }
                if status == StatusCode::SERVICE_UNAVAILABLE || status.as_u16() >= 500 {
                    return Err(false);
                }
                if !status.is_success() {
                    return Ok(FetchJsonOutcome::NotFound);
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = resp.chunk().await.map_err(|_| false)? {
                    if bytes.len() + chunk.len() > MAX_JSON_BYTES {
                        return Ok(FetchJsonOutcome::NotFound);
                    }
                    bytes.extend_from_slice(&chunk);
                }
                match serde_json::from_slice::<Value>(&bytes) {
                    Ok(v) => Ok(FetchJsonOutcome::Ok(v)),
                    Err(_) => Err(false),
                }
            })
            .await;

            *next = (*next).max(Instant::now() + gap);

            match res {
                Ok(Ok(outcome)) => return outcome,
                Ok(Err(rate_limited)) => {
                    failed_requests += 1;
                    if rate_limited || attempt == 1 {
                        return FetchJsonOutcome::TransientError(failed_requests);
                    }
                    *next = (*next).max(Instant::now() + Duration::from_millis(500));
                }
                Err(_) => {
                    failed_requests += 1;
                    if attempt == 1 {
                        return FetchJsonOutcome::TransientError(failed_requests);
                    }
                }
            }
        }
        FetchJsonOutcome::TransientError(failed_requests.max(1))
    }

    pub async fn download_image(&self, raw_url: &str) -> Result<Vec<u8>, String> {
        let Some(sanitized) = sanitize_artwork_url(raw_url) else {
            return Err("Untrusted or invalid artwork URL".into());
        };
        let url = Url::parse(&sanitized).map_err(|e| e.to_string())?;
        let res = tokio::time::timeout(self.timeout, async {
            let mut resp = self
                .image_client
                .get(url)
                .send()
                .await
                .map_err(|e| format!("Image download failed: {e}"))?;
            let status = resp.status();
            if !status.is_success() {
                return Err(format!("HTTP {}", status.as_u16()));
            }
            if resp
                .content_length()
                .is_some_and(|len| len > MAX_IMAGE_BYTES as u64)
            {
                return Err("oversized".into());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = resp
                .chunk()
                .await
                .map_err(|e| format!("Failed reading image stream: {e}"))?
            {
                if bytes.len() + chunk.len() > MAX_IMAGE_BYTES {
                    return Err("oversized".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        })
        .await;

        match res {
            Ok(inner) => inner,
            Err(_) => Err("timeout".into()),
        }
    }

    async fn fetch_caa(
        &self,
        entity: &str,
        mbid: &str,
        size: &str,
        is_excluded: &(dyn Fn(&str) -> bool + Send + Sync),
    ) -> (Option<String>, Option<String>, bool, u32) {
        if !is_valid_mbid(mbid) {
            return (None, None, false, 0);
        }
        let clean_mbid = mbid.trim().to_ascii_lowercase();
        let Ok(url) = Url::parse(&format!("{}/{}/{}", self.caa_base, entity, clean_mbid)) else {
            return (None, None, false, 0);
        };
        let fallback_front = sanitize_artwork_url(&format!(
            "{}/{}/{}/front-{}",
            self.caa_base,
            entity,
            clean_mbid,
            if size == "1200" { "1200" } else { "500" }
        ));

        match self.fetch_json("caa", self.caa_gap, url).await {
            FetchJsonOutcome::Ok(val) => {
                let extracted_rel = if entity == "release" {
                    Some(clean_mbid.clone())
                } else {
                    val.get("release")
                        .and_then(Value::as_str)
                        .and_then(|s| s.rsplit('/').find(|seg| !seg.is_empty()))
                        .filter(|id| is_valid_mbid(id))
                        .map(|s| s.to_ascii_lowercase())
                };
                let Some(images) = val.get("images").and_then(Value::as_array) else {
                    return (None, extracted_rel, false, 0);
                };
                if images.is_empty() {
                    return (None, extracted_rel, false, 0);
                }
                let front = images
                    .iter()
                    .find(|img| img.get("front").and_then(Value::as_bool) == Some(true))
                    .or_else(|| {
                        images.iter().find(|img| {
                            img.get("types")
                                .and_then(Value::as_array)
                                .is_some_and(|ts| {
                                    ts.iter().any(|t| {
                                        t.as_str().is_some_and(|s| s.eq_ignore_ascii_case("front"))
                                    })
                                })
                        })
                    })
                    .or_else(|| images.first());

                let Some(front_obj) = front else {
                    return (None, extracted_rel, false, 0);
                };
                let thumbs = front_obj.get("thumbnails");
                let get_thumb = |k: &str| {
                    thumbs
                        .and_then(|t| t.get(k))
                        .and_then(Value::as_str)
                        .map(String::from)
                };
                let main_img = front_obj
                    .get("image")
                    .and_then(Value::as_str)
                    .map(String::from);

                let candidates: Vec<Option<String>> = if size == "1200" {
                    vec![
                        get_thumb("1200"),
                        get_thumb("xl"),
                        main_img,
                        get_thumb("500"),
                        get_thumb("large"),
                        fallback_front,
                    ]
                } else {
                    vec![
                        get_thumb("500"),
                        get_thumb("large"),
                        fallback_front,
                        get_thumb("1200"),
                        main_img,
                        get_thumb("250"),
                        get_thumb("small"),
                    ]
                };

                for cand in candidates.into_iter().flatten() {
                    if let Some(sanitized) = sanitize_artwork_url(&cand) {
                        if !is_excluded(&sanitized) {
                            return (Some(sanitized), extracted_rel, false, 0);
                        }
                    }
                }
                (None, extracted_rel, false, 0)
            }
            FetchJsonOutcome::NotFound => (None, None, false, 0),
            FetchJsonOutcome::TransientError(reqs) => (None, None, true, reqs),
        }
    }

    async fn search_mb_release_groups(
        &self,
        query: &ArtworkQuery,
    ) -> (Vec<ScoredMbCandidate>, bool, u32) {
        if is_placeholder_artist(&query.artist)
            || (!has_meaningful_album(&query.album) && query.title.trim().is_empty())
        {
            return (Vec::new(), false, 0);
        }
        let primary_artist = extract_primary_artist(&query.artist);
        let target = if has_meaningful_album(&query.album) {
            normalize_core_title(&query.album)
        } else {
            normalize_core_title(&query.title)
        };
        let target_clean = if target.is_empty() {
            if has_meaningful_album(&query.album) {
                query.album.clone()
            } else {
                query.title.clone()
            }
        } else {
            target
        };
        let lucene = format!(
            "artist:\"{}\" AND releasegroup:\"{}\"",
            primary_artist.replace('\"', "\\\""),
            target_clean.replace('\"', "\\\"")
        );
        let Ok(mut url) = Url::parse(&format!("{}/release-group", self.mb_base)) else {
            return (Vec::new(), false, 0);
        };
        url.query_pairs_mut()
            .append_pair("query", &lucene)
            .append_pair("limit", "10")
            .append_pair("fmt", "json");

        match self.fetch_json("mb", self.mb_gap, url).await {
            FetchJsonOutcome::Ok(val) => {
                let Some(arr) = val.get("release-groups").and_then(Value::as_array) else {
                    return (Vec::new(), false, 0);
                };
                let mut scored: Vec<ScoredMbCandidate> = arr
                    .iter()
                    .filter_map(|v| serde_json::from_value::<MbReleaseGroup>(v.clone()).ok())
                    .filter(|rg| is_valid_mbid(&rg.id))
                    .map(|rg| score_release_group(&rg, query))
                    .filter(|s| s.accepted)
                    .collect();
                scored.sort_by_key(|a| std::cmp::Reverse(a.confidence));
                (scored, false, 0)
            }
            FetchJsonOutcome::NotFound => (Vec::new(), false, 0),
            FetchJsonOutcome::TransientError(reqs) => (Vec::new(), true, reqs),
        }
    }

    async fn fetch_releases_for_rg(
        &self,
        rg_mbid: &str,
        query: &ArtworkQuery,
    ) -> (Vec<ScoredMbCandidate>, bool, u32) {
        let Ok(mut url) = Url::parse(&format!("{}/release", self.mb_base)) else {
            return (Vec::new(), false, 0);
        };
        url.query_pairs_mut()
            .append_pair("release-group", &rg_mbid.to_ascii_lowercase())
            .append_pair("inc", "recordings+media+artist-credits")
            .append_pair("limit", "10")
            .append_pair("fmt", "json");

        match self.fetch_json("mb", self.mb_gap, url).await {
            FetchJsonOutcome::Ok(val) => {
                let Some(arr) = val.get("releases").and_then(Value::as_array) else {
                    return (Vec::new(), false, 0);
                };
                let mut scored: Vec<ScoredMbCandidate> = arr
                    .iter()
                    .filter_map(|v| serde_json::from_value::<MbReleaseSummary>(v.clone()).ok())
                    .filter(|r| is_valid_mbid(&r.id))
                    .map(|r| score_release(&r, query))
                    .filter(|s| s.accepted)
                    .collect();
                scored.sort_by_key(|a| std::cmp::Reverse(a.confidence));
                (scored, false, 0)
            }
            FetchJsonOutcome::NotFound => (Vec::new(), false, 0),
            FetchJsonOutcome::TransientError(reqs) => (Vec::new(), true, reqs),
        }
    }

    async fn search_mb_releases(
        &self,
        query: &ArtworkQuery,
    ) -> (Vec<ScoredMbCandidate>, bool, u32) {
        if is_placeholder_artist(&query.artist)
            || (!has_meaningful_album(&query.album) && query.title.trim().is_empty())
        {
            return (Vec::new(), false, 0);
        }
        let primary_artist = extract_primary_artist(&query.artist);
        let has_album = has_meaningful_album(&query.album);
        let raw_target = if has_album {
            &query.album
        } else {
            &query.title
        };
        let core = normalize_core_title(raw_target);
        let target = if core.is_empty() { raw_target } else { &core };
        let esc_artist = primary_artist.replace('\"', "\\\"");
        let esc_target = target.replace('\"', "\\\"");
        let lucene = if has_album {
            format!("artist:\"{esc_artist}\" AND release:\"{esc_target}\"")
        } else {
            format!("artist:\"{esc_artist}\" AND (release:\"{esc_target}\" OR recording:\"{esc_target}\")")
        };

        let Ok(mut url) = Url::parse(&format!("{}/release", self.mb_base)) else {
            return (Vec::new(), false, 0);
        };
        url.query_pairs_mut()
            .append_pair("query", &lucene)
            .append_pair("limit", "10")
            .append_pair("fmt", "json");

        match self.fetch_json("mb", self.mb_gap, url).await {
            FetchJsonOutcome::Ok(val) => {
                let Some(arr) = val.get("releases").and_then(Value::as_array) else {
                    return (Vec::new(), false, 0);
                };
                let mut scored: Vec<ScoredMbCandidate> = arr
                    .iter()
                    .filter_map(|v| serde_json::from_value::<MbReleaseSummary>(v.clone()).ok())
                    .filter(|r| is_valid_mbid(&r.id))
                    .map(|r| score_release(&r, query))
                    .filter(|s| s.accepted)
                    .collect();
                scored.sort_by_key(|a| std::cmp::Reverse(a.confidence));
                (scored, false, 0)
            }
            FetchJsonOutcome::NotFound => (Vec::new(), false, 0),
            FetchJsonOutcome::TransientError(reqs) => (Vec::new(), true, reqs),
        }
    }

    async fn search_itunes(
        &self,
        query: &ArtworkQuery,
        entity: &str,
        is_excluded: &(dyn Fn(&str) -> bool + Send + Sync),
    ) -> (
        Option<(String, Option<String>, Option<String>, u32)>,
        bool,
        u32,
    ) {
        let target_text = if entity == "album" {
            if has_meaningful_album(&query.album) {
                query.album.trim()
            } else {
                ""
            }
        } else {
            query.title.trim()
        };
        if target_text.is_empty() {
            return (None, false, 0);
        }
        let term = if query.artist.trim().is_empty() {
            target_text.to_string()
        } else {
            format!("{} {}", query.artist.trim(), target_text)
        };

        let Ok(mut url) = Url::parse(&format!("{}/search", self.itunes_base)) else {
            return (None, false, 0);
        };
        url.query_pairs_mut()
            .append_pair("term", &term)
            .append_pair("media", "music")
            .append_pair("entity", entity)
            .append_pair("limit", "10");

        match self.fetch_json("itunes", self.itunes_gap, url).await {
            FetchJsonOutcome::Ok(val) => {
                let Some(arr) = val.get("results").and_then(Value::as_array) else {
                    return (None, false, 0);
                };
                let items: Vec<ItunesCandidateInput> = arr
                    .iter()
                    .filter_map(|v| serde_json::from_value::<ItunesCandidateInput>(v.clone()).ok())
                    .collect();
                let ranked = if entity == "album" {
                    rank_itunes_albums(query, &items)
                } else {
                    rank_itunes_songs(query, &items)
                };
                for cand in ranked.into_iter().filter(|c| c.accepted) {
                    if let Some(sanitized) = sanitize_artwork_url(&cand.artwork_url) {
                        if !is_excluded(&sanitized) {
                            return (
                                Some((
                                    sanitized,
                                    cand.collection_name,
                                    Some(cand.artist),
                                    cand.score.round() as u32,
                                )),
                                false,
                                0,
                            );
                        }
                    }
                }
                (None, false, 0)
            }
            FetchJsonOutcome::NotFound => (None, false, 0),
            FetchJsonOutcome::TransientError(reqs) => (None, true, reqs),
        }
    }

    pub async fn discover(
        &self,
        raw_query: &ArtworkQuery,
        size: &str,
        exclude_urls: &[String],
    ) -> ProviderDiscoveryResult {
        let query = normalize_metadata_query(raw_query);
        let excluded_norm: Vec<String> = exclude_urls
            .iter()
            .map(|u| sanitize_artwork_url(u).unwrap_or_else(|| u.trim().to_string()))
            .collect();
        let is_excluded = |url: &str| -> bool {
            let norm = sanitize_artwork_url(url).unwrap_or_else(|| url.trim().to_string());
            excluded_norm.iter().any(|ex| ex == url || ex == &norm)
        };

        let mut transient_failure = false;
        let mut failed_http_requests = 0u32;

        // 1. MusicBrainz Release Group lookup
        let (rg_candidates, mb_trans, mb_reqs) = self.search_mb_release_groups(&query).await;
        transient_failure |= mb_trans;
        failed_http_requests += mb_reqs;

        let best_rg_mbid = rg_candidates.first().map(|c| c.mbid.clone());

        for candidate in rg_candidates.iter().take(3) {
            let (rg_url, caa_rel_mbid, caa_trans, caa_reqs) = self
                .fetch_caa("release-group", &candidate.mbid, size, &is_excluded)
                .await;
            transient_failure |= caa_trans;
            failed_http_requests += caa_reqs;
            if let Some(url) = rg_url {
                return ProviderDiscoveryResult {
                    url: Some(url),
                    source: "musicbrainz-caa".into(),
                    release_group_mbid: Some(candidate.mbid.clone()),
                    release_mbid: caa_rel_mbid,
                    confidence: candidate.confidence,
                    album: Some(candidate.title.clone()),
                    artist: Some(candidate.artist.clone()).filter(|s| !s.is_empty()),
                    transient_failure: false,
                    failed_http_requests,
                };
            }

            let mut rel_mbids = candidate.release_mbids.clone();
            if rel_mbids.is_empty() {
                let (rels, r_trans, r_reqs) =
                    self.fetch_releases_for_rg(&candidate.mbid, &query).await;
                transient_failure |= r_trans;
                failed_http_requests += r_reqs;
                for r in rels {
                    if !rel_mbids.contains(&r.mbid) {
                        rel_mbids.push(r.mbid);
                    }
                }
            }

            for rel_mbid in rel_mbids.into_iter().take(3) {
                let (rel_url, _, rcaa_trans, rcaa_reqs) = self
                    .fetch_caa("release", &rel_mbid, size, &is_excluded)
                    .await;
                transient_failure |= rcaa_trans;
                failed_http_requests += rcaa_reqs;
                if let Some(url) = rel_url {
                    return ProviderDiscoveryResult {
                        url: Some(url),
                        source: "musicbrainz-caa".into(),
                        release_group_mbid: Some(candidate.mbid.clone()),
                        release_mbid: Some(rel_mbid),
                        confidence: candidate.confidence,
                        album: Some(candidate.title.clone()),
                        artist: Some(candidate.artist.clone()).filter(|s| !s.is_empty()),
                        transient_failure: false,
                        failed_http_requests,
                    };
                }
            }
        }

        // 2. Direct MusicBrainz Release search fallback
        if !mb_trans {
            let (direct_rels, dr_trans, dr_reqs) = self.search_mb_releases(&query).await;
            transient_failure |= dr_trans;
            failed_http_requests += dr_reqs;
            for rel_cand in direct_rels.into_iter().take(2) {
                let (rel_url, _, rcaa_trans, rcaa_reqs) = self
                    .fetch_caa("release", &rel_cand.mbid, size, &is_excluded)
                    .await;
                transient_failure |= rcaa_trans;
                failed_http_requests += rcaa_reqs;
                if let Some(url) = rel_url {
                    return ProviderDiscoveryResult {
                        url: Some(url),
                        source: "musicbrainz-caa".into(),
                        release_group_mbid: rel_cand.release_group_mbid,
                        release_mbid: Some(rel_cand.mbid),
                        confidence: rel_cand.confidence,
                        album: Some(rel_cand.title),
                        artist: None,
                        transient_failure: false,
                        failed_http_requests,
                    };
                }
            }
        }

        // 3. iTunes Search API fallback (song -> album -> primary-artist fallback)
        let (song_hit, it_trans, it_reqs) = self.search_itunes(&query, "song", &is_excluded).await;
        transient_failure |= it_trans;
        failed_http_requests += it_reqs;
        if let Some((url, album, artist, score)) = song_hit {
            return ProviderDiscoveryResult {
                url: Some(url),
                source: "itunes".into(),
                release_group_mbid: best_rg_mbid,
                release_mbid: None,
                confidence: score,
                album,
                artist,
                transient_failure: false,
                failed_http_requests,
            };
        }

        if !it_trans && has_meaningful_album(&query.album) && !query.artist.is_empty() {
            let (album_hit, alb_trans, alb_reqs) =
                self.search_itunes(&query, "album", &is_excluded).await;
            transient_failure |= alb_trans;
            failed_http_requests += alb_reqs;
            if let Some((url, album, artist, score)) = album_hit {
                return ProviderDiscoveryResult {
                    url: Some(url),
                    source: "itunes".into(),
                    release_group_mbid: best_rg_mbid,
                    release_mbid: None,
                    confidence: score.min(85),
                    album,
                    artist,
                    transient_failure: false,
                    failed_http_requests,
                };
            }
        }

        let primary_artist = extract_primary_artist(&query.artist);
        if !it_trans
            && !primary_artist.is_empty()
            && normalize_for_matching(&primary_artist) != normalize_for_matching(&query.artist)
        {
            let mut alt_query = query.clone();
            alt_query.artist = primary_artist;
            let (alt_hit, alt_trans, alt_reqs) =
                self.search_itunes(&alt_query, "song", &is_excluded).await;
            transient_failure |= alt_trans;
            failed_http_requests += alt_reqs;
            if let Some((url, album, artist, score)) = alt_hit {
                return ProviderDiscoveryResult {
                    url: Some(url),
                    source: "itunes".into(),
                    release_group_mbid: best_rg_mbid,
                    release_mbid: None,
                    confidence: score.min(75),
                    album,
                    artist,
                    transient_failure: false,
                    failed_http_requests,
                };
            }
        }

        ProviderDiscoveryResult {
            url: None,
            source: "none".into(),
            release_group_mbid: best_rg_mbid,
            release_mbid: None,
            confidence: 0,
            album: None,
            artist: None,
            transient_failure,
            failed_http_requests,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn validates_and_upgrades_only_trusted_artwork_hosts() {
        assert_eq!(
            sanitize_artwork_url(
                "http://coverartarchive.org/release-group/11111111-2222-3333-4444-555555555555/front-500"
            ),
            Some(
                "https://coverartarchive.org/release-group/11111111-2222-3333-4444-555555555555/front-500"
                    .into()
            )
        );
        assert_eq!(
            sanitize_artwork_url("https://is1-ssl.mzstatic.com/image/thumb/600x600bb.jpg"),
            Some("https://is1-ssl.mzstatic.com/image/thumb/600x600bb.jpg".into())
        );
        assert!(!is_valid_artwork_url("https://evil.example.com/cover.jpg"));
        assert!(!is_valid_artwork_url("javascript:alert(1)"));
    }

    #[tokio::test]
    async fn discovers_musicbrainz_caa_and_falls_back_to_itunes_on_404() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");

        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("");
                let (status, body) = if path.starts_with("/release-group?") {
                    (
                        "200 OK",
                        serde_json::json!({
                            "release-groups": [{
                                "id": "11111111-2222-3333-4444-555555555555",
                                "title": "Discovery",
                                "primary-type": "Album",
                                "artist-credit": [{ "name": "Daft Punk" }]
                            }]
                        })
                        .to_string(),
                    )
                } else if path.starts_with("/release-group/11111111") {
                    ("404 Not Found", "{}".to_string())
                } else if path.starts_with("/release?") {
                    ("200 OK", serde_json::json!({ "releases": [] }).to_string())
                } else if path.starts_with("/search?") {
                    (
                        "200 OK",
                        serde_json::json!({
                            "resultCount": 1,
                            "results": [{
                                "trackName": "One More Time",
                                "artistName": "Daft Punk",
                                "collectionName": "Discovery",
                                "artworkUrl100": "https://is1-ssl.mzstatic.com/image/thumb/dp/100x100bb.jpg",
                                "trackTimeMillis": 320000
                            }]
                        })
                        .to_string(),
                    )
                } else {
                    ("404 Not Found", "{}".to_string())
                };
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes()).await;
            }
        });

        let providers =
            NativeArtworkProviders::with_test_endpoints(base.clone(), base.clone(), base);
        let query = ArtworkQuery {
            id: "t1".into(),
            title: "One More Time".into(),
            artist: "Daft Punk".into(),
            album: "Discovery".into(),
            duration_ms: Some(320_000),
        };
        let res = providers.discover(&query, "500", &[]).await;
        assert_eq!(res.source, "itunes");
        assert_eq!(
            res.url.as_deref(),
            Some("https://is1-ssl.mzstatic.com/image/thumb/dp/600x600bb.jpg")
        );
        server.abort();
    }
}
