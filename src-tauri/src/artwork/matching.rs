use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::LazyLock;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtworkQuery {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: Option<i64>,
}

impl ArtworkQuery {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.len() > 2048
            || self.title.len() > 2048
            || self.artist.len() > 2048
            || self.album.len() > 2048
        {
            return Err("Artwork query field exceeds maximum length of 2048 bytes.".into());
        }
        if let Some(d) = self.duration_ms {
            if !(0..=86_400_000).contains(&d) {
                return Err("Artwork query durationMs out of valid range.".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MbAlias {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MbArtist {
    pub name: Option<String>,
    #[serde(rename = "sort-name")]
    pub sort_name: Option<String>,
    #[serde(default)]
    pub aliases: Vec<MbAlias>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MbArtistCredit {
    pub name: Option<String>,
    pub joinphrase: Option<String>,
    pub artist: Option<MbArtist>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MbTrackEntry {
    pub title: Option<String>,
    pub length: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MbMediaEntry {
    #[serde(default)]
    pub tracks: Vec<MbTrackEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MbReleaseGroupRef {
    pub id: Option<String>,
    #[serde(rename = "primary-type")]
    pub primary_type: Option<String>,
    #[serde(rename = "secondary-types", default)]
    pub secondary_types: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MbReleaseSummary {
    pub id: String,
    pub title: Option<String>,
    pub status: Option<String>,
    pub disambiguation: Option<String>,
    #[serde(rename = "artist-credit", default)]
    pub artist_credit: Vec<MbArtistCredit>,
    #[serde(rename = "release-group")]
    pub release_group: Option<MbReleaseGroupRef>,
    #[serde(default)]
    pub media: Vec<MbMediaEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MbReleaseGroup {
    pub id: String,
    pub title: String,
    #[serde(rename = "primary-type")]
    pub primary_type: Option<String>,
    #[serde(rename = "secondary-types", default)]
    pub secondary_types: Vec<String>,
    pub disambiguation: Option<String>,
    #[serde(rename = "artist-credit", default)]
    pub artist_credit: Vec<MbArtistCredit>,
    #[serde(default)]
    pub releases: Vec<MbReleaseSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScoredMbCandidate {
    pub mbid: String,
    pub release_group_mbid: Option<String>,
    pub title: String,
    pub artist: String,
    pub confidence: u32,
    pub accepted: bool,
    pub rejection_reason: Option<String>,
    pub release_mbids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItunesCandidateInput {
    pub track_name: Option<String>,
    pub artist_name: Option<String>,
    pub collection_name: Option<String>,
    pub artwork_url100: Option<String>,
    pub track_time_millis: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScoredItunesCandidate {
    pub title: String,
    pub artist: String,
    pub collection_name: Option<String>,
    pub artwork_url: String,
    pub score: f64,
    pub accepted: bool,
    pub rejection_reason: Option<String>,
}

static MBID_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        .unwrap()
});

static NOISE_BRACKETS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\s*[\(\[\{][^\)\]\}]*\b(?:official(?:\s+music)?\s+video|music\s+video|video|official\s+audio|audio\s+only|full\s+audio|audio|lyric(?:s)?\s+video|lyrics?|visualizer|hd|4k|1080p|720p|hq|320\s*kbps|flac|lossless|remaster(?:ed)?|explicit|clean)\b[^\)\]\}]*[\)\]\}]").unwrap()
});

static TRAILING_NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:\s*[-–—|~]\s*topic\b|\s+\b(?:official\s+music\s+video|official\s+video|official\s+audio|lyric(?:s)?\s+video|music\s+video|hd|4k|1080p|720p|hq|lyrics?|audio)\b)+$").unwrap()
});

static CORE_STRIP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\s*[\(\[\{][^\)\]\}]*\b(?:deluxe|expanded|special|collector|anniversary|remaster|remastered|bonus|edition|version|live|remix|remixes|explicit|clean|disc\s*\d+|cd\s*\d+|vol\.?\s*\d+|ep|single|soundtrack|ost|feat\.?|ft\.?|featuring|with)\b[^\)\]\}]*[\)\]\}]|\s*[\(\[](?:18|19|20)\d{2}[\)\]]|\s+[-–—:]\s*(?:[0-9]{4}\s+)?(?:deluxe|expanded|special|anniversary|remaster|remastered|edition|version|bonus\s+track|live|ep|single)\b.*$|\s+(?:feat|ft|featuring)\.?\s+.+$").unwrap()
});

static COLLAB_SPLIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x|dan|and)\s+|\s*[,;&/]\s*").unwrap()
});

static PROMOTERS: &[&str] = &[
    "7clouds",
    "syrebralvibes",
    "trap nation",
    "bass nation",
    "chill nation",
    "cloudkid",
    "sensual musique",
    "mrsuicidesheep",
    "proximity",
    "t series",
    "vevo",
    "lyrical lemonade",
    "unique vibes",
    "cassiopeia",
    "dan music",
    "wavemusic",
    "taj tracks",
    "superblyrics",
    "gold coast music",
    "shadow music",
    "chilledcow",
    "monstercat",
    "koala kontrol",
    "the vibe guide",
    "latin urban",
    "regravar",
];

static PLACEHOLDER_ALBUMS: &[&str] = &[
    "",
    "unknown",
    "unknown album",
    "untitled",
    "none",
    "n a",
    "na",
    "null",
    "undefined",
    "single",
    "singles",
    "ep",
    "album",
    "music",
    "downloads",
    "audio",
    "tracks",
    "various",
    "various artists",
    "youtube",
    "official audio",
    "lyrics",
];

pub fn is_valid_mbid(s: &str) -> bool {
    MBID_REGEX.is_match(s.trim())
}

pub fn normalize_for_matching(input: &str) -> String {
    let decomposed: String = input
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .collect();
    let replaced = decomposed
        .replace(['’', '\'', '`', '‘'], "")
        .replace('&', " and ");
    let cleaned: String = replaced
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn is_year_only(s: &str) -> bool {
    let trimmed = s
        .trim()
        .trim_matches(|c| matches!(c, '(' | ')' | '[' | ']' | '{' | '}'))
        .trim();
    trimmed.len() == 4
        && (trimmed.starts_with("18") || trimmed.starts_with("19") || trimmed.starts_with("20"))
        && trimmed.chars().all(|c| c.is_ascii_digit())
}

pub fn is_placeholder_artist(artist: &str) -> bool {
    let norm = normalize_for_matching(artist);
    matches!(
        norm.as_str(),
        "" | "unknown"
            | "unknown artist"
            | "various"
            | "various artists"
            | "va"
            | "none"
            | "null"
            | "undefined"
    )
}

pub fn is_suspect_channel(artist: &str) -> bool {
    if is_placeholder_artist(artist) {
        return true;
    }
    let norm = normalize_for_matching(artist);
    if PROMOTERS.contains(&norm.as_str()) {
        return true;
    }
    norm.ends_with("vevo")
        || norm.ends_with("topic")
        || norm.ends_with("channel")
        || matches!(
            norm.as_str(),
            "lyrics" | "lyric" | "audio" | "official audio" | "official video"
        )
}

pub fn has_meaningful_album(album: &str) -> bool {
    if is_year_only(album) {
        return false;
    }
    let cleaned = normalize_for_matching(&clean_noise(album));
    !cleaned.is_empty()
        && !PLACEHOLDER_ALBUMS.contains(&cleaned.as_str())
        && !is_year_only(&cleaned)
}

pub fn clean_noise(input: &str) -> String {
    let without_brackets = NOISE_BRACKETS.replace_all(input.trim(), "");
    let without_trailing = TRAILING_NOISE.replace_all(&without_brackets, "");
    without_trailing
        .trim()
        .trim_matches(|c| matches!(c, '-' | '–' | '—' | '|' | '~'))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn extract_primary_artist(artist: &str) -> String {
    let cleaned = clean_noise(artist);
    let lower = cleaned.to_ascii_lowercase();
    // Preserve compound artists like "Tyler, The Creator" or "Florence and the Machine"
    if lower.contains(", the ") || lower.contains(" and the ") || lower.contains(" & the ") {
        let feat_re = Regex::new(r"(?i)\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x)\s+").unwrap();
        return feat_re
            .split(&cleaned)
            .next()
            .unwrap_or(&cleaned)
            .trim()
            .to_string();
    }
    COLLAB_SPLIT
        .split(&cleaned)
        .next()
        .unwrap_or(&cleaned)
        .trim()
        .to_string()
}

pub fn normalize_metadata_query(query: &ArtworkQuery) -> ArtworkQuery {
    let mut artist = clean_noise(&query.artist);
    let mut title = clean_noise(&query.title);

    if is_suspect_channel(&artist) {
        for sep in [" - ", " – ", " — ", " | ", " ~ "] {
            if let Some((left, right)) = title.split_once(sep) {
                let c_left = clean_noise(left);
                let c_right = clean_noise(right);
                if !c_left.is_empty() && !c_right.is_empty() {
                    artist = c_left;
                    title = c_right;
                    break;
                }
            }
        }
    }
    if is_placeholder_artist(&artist) || is_suspect_channel(&artist) {
        artist.clear();
    }

    let album = if has_meaningful_album(&query.album) {
        clean_noise(&query.album)
    } else {
        String::new()
    };

    ArtworkQuery {
        id: query.id.clone(),
        title,
        artist,
        album,
        duration_ms: query.duration_ms,
    }
}

pub fn get_artwork_cache_key(query: &ArtworkQuery) -> String {
    let norm = normalize_metadata_query(query);
    let primary_artist = normalize_for_matching(&extract_primary_artist(&norm.artist));
    let clean_title = normalize_for_matching(&clean_noise(&norm.title));
    if primary_artist.is_empty() && clean_title.is_empty() {
        return String::new();
    }
    format!("{primary_artist}::{clean_title}")
}

pub fn get_album_artwork_cache_key(query: &ArtworkQuery) -> String {
    let norm = normalize_metadata_query(query);
    if !has_meaningful_album(&norm.album) {
        return get_artwork_cache_key(&norm);
    }
    let primary_artist = normalize_for_matching(&extract_primary_artist(&norm.artist));
    let clean_album = normalize_for_matching(&clean_noise(&norm.album));
    if primary_artist.is_empty() || clean_album.is_empty() {
        return get_artwork_cache_key(&norm);
    }
    format!("album::{primary_artist}::{clean_album}")
}

pub fn compute_query_fingerprint(query: &ArtworkQuery) -> String {
    format!(
        "{}|{}",
        get_album_artwork_cache_key(query),
        get_artwork_cache_key(query)
    )
}

pub fn normalize_core_title(raw: &str) -> String {
    let cleaned = clean_noise(raw);
    let stripped = CORE_STRIP.replace_all(&cleaned, "");
    normalize_for_matching(&stripped)
}

#[derive(Debug, Clone, Default)]
pub struct EditionFlags {
    pub deluxe: bool,
    pub live: bool,
    pub remix: bool,
    pub compilation: bool,
    pub soundtrack: bool,
    pub ep: bool,
    pub single: bool,
    pub acoustic: bool,
    pub instrumental: bool,
}

pub fn extract_edition_flags(text: &str) -> EditionFlags {
    let lower = text.to_ascii_lowercase();
    let has = |pat: &str| Regex::new(pat).unwrap().is_match(&lower);
    EditionFlags {
        deluxe: has(
            r"\b(deluxe|expanded|special\s+edition|collector|anniversary\s+edition|bonus\s+track)\b",
        ),
        live: has(r"\b(live|unplugged|in\s+concert)\b"),
        remix: has(r"\b(remix|remixes|reworked|dub\s+mix|club\s+mix|vip\s+mix)\b"),
        compilation: has(r"\b(greatest\s+hits|best\s+of|anthology|the\s+essentials|compilation)\b"),
        soundtrack: has(
            r"\b(soundtrack|o\.?s\.?t\.?|original\s+motion\s+picture|original\s+score)\b",
        ),
        ep: has(r"\b(e\.?p\.?)\b"),
        single: has(r"\b(single)\b"),
        acoustic: has(r"\b(acoustic)\b"),
        instrumental: has(r"\b(instrumental)\b"),
    }
}

pub fn levenshtein_distance(a: &str, b: &str) -> usize {
    if a == b {
        return 0;
    }
    let a_chars: Vec<char> = a.chars().take(512).collect();
    let b_chars: Vec<char> = b.chars().take(512).collect();
    if a_chars.is_empty() {
        return b_chars.len();
    }
    if b_chars.is_empty() {
        return a_chars.len();
    }
    let mut prev: Vec<usize> = (0..=b_chars.len()).collect();
    for (i, &ca) in a_chars.iter().enumerate() {
        let mut curr = vec![i + 1; b_chars.len() + 1];
        for (j, &cb) in b_chars.iter().enumerate() {
            let cost = usize::from(ca != cb);
            curr[j + 1] = (curr[j] + 1).min(prev[j + 1] + 1).min(prev[j] + cost);
        }
        prev = curr;
    }
    prev[b_chars.len()]
}

pub fn compute_text_similarity(target_raw: &str, candidate_raw: &str) -> f64 {
    let target_full = normalize_for_matching(target_raw);
    let candidate_full = normalize_for_matching(candidate_raw);
    if target_full.is_empty() || candidate_full.is_empty() {
        return 0.0;
    }
    if target_full == candidate_full {
        return 1.0;
    }
    let target_core = normalize_core_title(target_raw);
    let candidate_core = normalize_core_title(candidate_raw);
    if !target_core.is_empty() && target_core == candidate_core {
        return 0.96;
    }
    let a = if target_core.is_empty() {
        &target_full
    } else {
        &target_core
    };
    let b = if candidate_core.is_empty() {
        &candidate_full
    } else {
        &candidate_core
    };

    let tokens_a: HashSet<&str> = a.split_whitespace().collect();
    let tokens_b: HashSet<&str> = b.split_whitespace().collect();
    if tokens_a.is_empty() || tokens_b.is_empty() {
        return 0.0;
    }
    let intersection = tokens_a.intersection(&tokens_b).count();
    if intersection == 0 {
        return 0.0;
    }
    let union = tokens_a.union(&tokens_b).count();
    let jaccard = intersection as f64 / union as f64;
    let containment = intersection as f64 / tokens_a.len().min(tokens_b.len()) as f64;

    if a.contains(b) || b.contains(a) {
        return (0.78f64).max(jaccard * 0.6 + containment * 0.4);
    }
    jaccard * 0.65 + containment * 0.35
}

pub fn compute_string_similarity(a: &str, b: &str) -> f64 {
    let left = normalize_for_matching(a);
    let right = normalize_for_matching(b);
    if left == right {
        return if left.is_empty() { 0.0 } else { 1.0 };
    }
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    if left.contains(&right) || right.contains(&left) {
        return 0.92;
    }
    let left_core = normalize_core_title(a);
    let right_core = normalize_core_title(b);
    if left_core.len() >= 4 && right_core.len() >= 4 {
        if left_core == right_core {
            return 0.94;
        }
        if (left_core.contains(&right_core) || right_core.contains(&left_core))
            && left_core.len().min(right_core.len()) >= 6
        {
            return 0.88;
        }
    }
    let dist = levenshtein_distance(&left, &right);
    let max_len = left.chars().count().max(right.chars().count());
    (1.0 - (dist as f64 / max_len as f64)).max(0.0)
}

fn extract_artist_variants(raw_artist: &str) -> Vec<String> {
    let cleaned = clean_noise(raw_artist);
    let primary = extract_primary_artist(&cleaned);
    let mut out = Vec::new();
    let full_norm = normalize_for_matching(&cleaned);
    let prim_norm = normalize_for_matching(&primary);
    if !full_norm.is_empty() {
        out.push(full_norm);
    }
    if !prim_norm.is_empty() && !out.contains(&prim_norm) {
        out.push(prim_norm);
    }
    for part in COLLAB_SPLIT.split(&cleaned) {
        let p = normalize_for_matching(part);
        if !p.is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

fn collect_mb_artist_names(credits: &[MbArtistCredit]) -> Vec<String> {
    let mut names = Vec::new();
    let mut joined = String::new();
    for entry in credits {
        if let Some(name) = &entry.name {
            let n = normalize_for_matching(name);
            if !n.is_empty() && !names.contains(&n) {
                names.push(n);
            }
            joined.push_str(name);
            joined.push_str(entry.joinphrase.as_deref().unwrap_or(" "));
        }
        if let Some(artist) = &entry.artist {
            if let Some(aname) = &artist.name {
                let n = normalize_for_matching(aname);
                if !n.is_empty() && !names.contains(&n) {
                    names.push(n);
                }
            }
            if let Some(sort) = &artist.sort_name {
                let n = normalize_for_matching(sort);
                if !n.is_empty() && !names.contains(&n) {
                    names.push(n);
                }
                if sort.contains(',') {
                    let rev: Vec<&str> = sort.split(',').map(str::trim).collect();
                    let rev_joined = rev.into_iter().rev().collect::<Vec<_>>().join(" ");
                    let rn = normalize_for_matching(&rev_joined);
                    if !rn.is_empty() && !names.contains(&rn) {
                        names.push(rn);
                    }
                }
            }
            for alias in &artist.aliases {
                if let Some(al) = &alias.name {
                    let n = normalize_for_matching(al);
                    if !n.is_empty() && !names.contains(&n) {
                        names.push(n);
                    }
                }
            }
        }
    }
    let full = normalize_for_matching(&joined);
    if !full.is_empty() && !names.contains(&full) {
        names.push(full);
    }
    names
}

pub fn compute_mb_artist_similarity(query_artist: &str, credits: &[MbArtistCredit]) -> f64 {
    let q_vars = extract_artist_variants(query_artist);
    let c_names = collect_mb_artist_names(credits);
    if q_vars.is_empty() || c_names.is_empty() {
        return 0.0;
    }
    let mut best = 0.0f64;
    for q in &q_vars {
        for c in &c_names {
            if q == c {
                return 1.0;
            }
            let q_no_the = q.strip_prefix("the ").unwrap_or(q);
            let c_no_the = c.strip_prefix("the ").unwrap_or(c);
            if !q_no_the.is_empty() && q_no_the == c_no_the {
                best = best.max(0.98);
                continue;
            }
            best = best.max(compute_text_similarity(q, c));
        }
    }
    best
}

pub fn compute_itunes_artist_similarity(query_artist: &str, candidate_artist: &str) -> f64 {
    let base = compute_string_similarity(query_artist, candidate_artist);
    if base >= 0.9 {
        return base;
    }
    let stop: HashSet<&str> = ["and", "feat", "ft", "featuring", "with", "vs", "x", "dan"]
        .into_iter()
        .collect();
    let tok_a: HashSet<String> = normalize_for_matching(query_artist)
        .split_whitespace()
        .filter(|t| !stop.contains(*t))
        .map(String::from)
        .collect();
    let tok_b: HashSet<String> = normalize_for_matching(candidate_artist)
        .split_whitespace()
        .filter(|t| !stop.contains(*t))
        .map(String::from)
        .collect();
    if tok_a.is_empty() || tok_b.is_empty() {
        return base;
    }
    let overlap = tok_a.intersection(&tok_b).count();
    if overlap == 0 {
        return base;
    }
    let union = tok_a.union(&tok_b).count();
    let jaccard = overlap as f64 / union as f64;
    if tok_a.len() >= 2 && tok_b.len() >= 2 && jaccard >= 0.7 {
        return base.max(jaccard * 0.96);
    }
    for qp in COLLAB_SPLIT.split(query_artist) {
        let qn = normalize_for_matching(qp);
        if qn.len() < 3 {
            continue;
        }
        for cp in COLLAB_SPLIT.split(candidate_artist) {
            let cn = normalize_for_matching(cp);
            if cn.len() >= 3 && qn == cn {
                return base.max(0.88);
            }
        }
    }
    base
}

fn extract_release_mbids(releases: &[MbReleaseSummary]) -> Vec<String> {
    let mut sorted = releases.to_vec();
    sorted.sort_by_key(|r| {
        if r.status
            .as_deref()
            .unwrap_or("")
            .eq_ignore_ascii_case("official")
        {
            0
        } else {
            1
        }
    });
    sorted
        .into_iter()
        .map(|r| r.id)
        .filter(|id| is_valid_mbid(id))
        .collect()
}

pub fn score_release_group(rg: &MbReleaseGroup, query: &ArtworkQuery) -> ScoredMbCandidate {
    let has_album = has_meaningful_album(&query.album);
    let target_title = if has_album {
        &query.album
    } else {
        &query.title
    };
    let artist_sim = compute_mb_artist_similarity(&query.artist, &rg.artist_credit);
    let title_sim = compute_text_similarity(target_title, &rg.title);
    let artist_display = rg
        .artist_credit
        .iter()
        .filter_map(|c| {
            c.name
                .as_deref()
                .or_else(|| c.artist.as_ref()?.name.as_deref())
        })
        .collect::<Vec<_>>()
        .join(", ");
    let release_mbids = extract_release_mbids(&rg.releases);

    if artist_sim < 0.45 || title_sim < 0.5 {
        let low = ((artist_sim * 40.0 + title_sim * 40.0) * 0.5).round() as u32;
        let reason = if artist_sim < 0.45 {
            format!(
                "Artist similarity too low ({}%)",
                (artist_sim * 100.0).round() as u32
            )
        } else {
            format!(
                "Title/album similarity too low ({}%)",
                (title_sim * 100.0).round() as u32
            )
        };
        return ScoredMbCandidate {
            mbid: rg.id.clone(),
            release_group_mbid: Some(rg.id.clone()),
            title: rg.title.clone(),
            artist: artist_display,
            confidence: low.min(35),
            accepted: false,
            rejection_reason: Some(reason),
            release_mbids,
        };
    }

    let mut score = artist_sim * 45.0 + title_sim * 45.0;
    let primary_type = rg
        .primary_type
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    let sec_types: Vec<String> = rg
        .secondary_types
        .iter()
        .map(|t| t.to_ascii_lowercase())
        .collect();
    let meta_text = format!(
        "{} {}",
        rg.title,
        rg.disambiguation.as_deref().unwrap_or("")
    );
    let q_flags = extract_edition_flags(&format!("{} {}", query.album, query.title));
    let c_flags = extract_edition_flags(&meta_text);

    if has_album {
        if (q_flags.ep && primary_type == "ep") || (q_flags.single && primary_type == "single") {
            score += 8.0;
        } else if primary_type == "album" {
            score += 10.0;
        } else if primary_type == "ep" {
            score += 5.0;
        } else if primary_type == "single" {
            score += 3.0;
        }
    } else if matches!(primary_type.as_str(), "album" | "single" | "ep") {
        score += 8.0;
    }

    let is_live = sec_types.iter().any(|s| s == "live") || c_flags.live;
    let is_remix = sec_types.iter().any(|s| s == "remix" || s == "dj-mix") || c_flags.remix;
    let is_comp = sec_types.iter().any(|s| s == "compilation") || c_flags.compilation;
    let is_ost = sec_types.iter().any(|s| s == "soundtrack") || c_flags.soundtrack;

    if is_live && !q_flags.live {
        score -= 28.0;
    } else if is_live && q_flags.live {
        score += 6.0;
    }
    if is_remix && !q_flags.remix {
        score -= 28.0;
    } else if is_remix && q_flags.remix {
        score += 6.0;
    }
    if is_comp && !q_flags.compilation {
        score -= 22.0;
    } else if is_comp && q_flags.compilation {
        score += 6.0;
    }
    if is_ost && !q_flags.soundtrack {
        score -= 16.0;
    } else if is_ost && q_flags.soundtrack {
        score += 6.0;
    }

    if q_flags.deluxe {
        score += if c_flags.deluxe { 5.0 } else { -3.0 };
    } else if c_flags.deluxe {
        score -= 4.0;
    }

    let clamped = score.round().clamp(0.0, 100.0) as u32;
    let accepted = clamped >= 62;
    let rejection_reason = if accepted {
        None
    } else if is_live && !q_flags.live {
        Some("Live edition penalty lowered confidence".into())
    } else if is_remix && !q_flags.remix {
        Some("Remix edition penalty lowered confidence".into())
    } else if is_comp && !q_flags.compilation {
        Some("Compilation penalty lowered confidence".into())
    } else {
        Some(format!("Confidence {clamped} below minimum threshold 62"))
    };

    ScoredMbCandidate {
        mbid: rg.id.clone(),
        release_group_mbid: Some(rg.id.clone()),
        title: rg.title.clone(),
        artist: artist_display,
        confidence: clamped,
        accepted,
        rejection_reason,
        release_mbids,
    }
}

pub fn score_release(rel: &MbReleaseSummary, query: &ArtworkQuery) -> ScoredMbCandidate {
    let has_album = has_meaningful_album(&query.album);
    let target_title = if has_album {
        &query.album
    } else {
        &query.title
    };
    let artist_sim = if !rel.artist_credit.is_empty() {
        compute_mb_artist_similarity(&query.artist, &rel.artist_credit)
    } else {
        0.85
    };
    let rel_title = rel.title.as_deref().unwrap_or(target_title);
    let release_title_sim = compute_text_similarity(target_title, rel_title);

    let mut matched_track_sim = 0.0f64;
    let mut matched_track_len: Option<i64> = None;
    if !query.title.trim().is_empty() {
        for m in &rel.media {
            for t in &m.tracks {
                let sim = compute_text_similarity(&query.title, t.title.as_deref().unwrap_or(""));
                if sim > matched_track_sim {
                    matched_track_sim = sim;
                    matched_track_len = t.length;
                }
            }
        }
    }

    let effective_title_sim = if !has_album && matched_track_sim >= 0.78 {
        release_title_sim.max(matched_track_sim)
    } else {
        release_title_sim
    };

    let rg_mbid = rel
        .release_group
        .as_ref()
        .and_then(|rg| rg.id.as_deref())
        .filter(|id| is_valid_mbid(id))
        .map(String::from);

    if artist_sim < 0.45 || effective_title_sim < 0.5 {
        return ScoredMbCandidate {
            mbid: rel.id.clone(),
            release_group_mbid: rg_mbid,
            title: rel_title.to_string(),
            artist: String::new(),
            confidence: 25,
            accepted: false,
            rejection_reason: Some("Artist or release title similarity too low".into()),
            release_mbids: vec![rel.id.clone()],
        };
    }

    let mut score = artist_sim * 45.0 + effective_title_sim * 42.0;
    if rel
        .status
        .as_deref()
        .unwrap_or("")
        .eq_ignore_ascii_case("official")
    {
        score += 8.0;
    }

    let q_flags = extract_edition_flags(&format!("{} {}", query.album, query.title));
    let r_flags = extract_edition_flags(&format!(
        "{} {}",
        rel_title,
        rel.disambiguation.as_deref().unwrap_or("")
    ));
    let sec_types: Vec<String> = rel
        .release_group
        .as_ref()
        .map(|rg| {
            rg.secondary_types
                .iter()
                .map(|s| s.to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default();

    if (sec_types.iter().any(|s| s == "live") || r_flags.live) && !q_flags.live {
        score -= 25.0;
    }
    if (sec_types.iter().any(|s| s == "remix") || r_flags.remix) && !q_flags.remix {
        score -= 25.0;
    }
    if (sec_types.iter().any(|s| s == "compilation") || r_flags.compilation) && !q_flags.compilation
    {
        score -= 20.0;
    }

    if matched_track_sim >= 0.8 {
        score += 5.0;
        if let (Some(q_dur), Some(t_len)) = (
            query.duration_ms.filter(|&d| d > 0),
            matched_track_len.filter(|&d| d > 0),
        ) {
            let diff = (q_dur - t_len).abs();
            if diff <= 5_000 {
                score += 6.0;
            } else if diff <= 15_000 {
                score += 3.0;
            } else if diff > 45_000 {
                score -= 12.0;
            }
        }
    }

    let clamped = score.round().clamp(0.0, 100.0) as u32;
    let accepted = clamped >= 62;
    ScoredMbCandidate {
        mbid: rel.id.clone(),
        release_group_mbid: rg_mbid,
        title: rel_title.to_string(),
        artist: String::new(),
        confidence: clamped,
        accepted,
        rejection_reason: if accepted {
            None
        } else {
            Some(format!("Confidence {clamped} below minimum threshold 62"))
        },
        release_mbids: vec![rel.id.clone()],
    }
}

pub fn rank_itunes_songs(
    query: &ArtworkQuery,
    items: &[ItunesCandidateInput],
) -> Vec<ScoredItunesCandidate> {
    let mut out = Vec::new();
    let q_flags = extract_edition_flags(&query.title);
    let has_artist = !query.artist.trim().is_empty();
    let has_album = has_meaningful_album(&query.album);
    let size_re = Regex::new(r"/\d+x\d+bb\.").unwrap();

    for item in items {
        let Some(track_name) = item.track_name.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(art100) = item.artwork_url100.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        let artist_name = item.artist_name.as_deref().unwrap_or("");
        let title_sim = compute_string_similarity(&query.title, track_name);
        let artist_sim = if has_artist && !artist_name.is_empty() {
            compute_itunes_artist_similarity(&query.artist, artist_name)
        } else {
            1.0
        };

        let high_res = size_re.replace(art100, "/600x600bb.").to_string();

        if title_sim < 0.62 {
            out.push(ScoredItunesCandidate {
                title: track_name.into(),
                artist: artist_name.into(),
                collection_name: item.collection_name.clone(),
                artwork_url: high_res,
                score: (title_sim * 100.0).round(),
                accepted: false,
                rejection_reason: Some(format!(
                    "Title similarity too low ({}%)",
                    (title_sim * 100.0).round() as u32
                )),
            });
            continue;
        }
        if has_artist && artist_sim < 0.45 {
            out.push(ScoredItunesCandidate {
                title: track_name.into(),
                artist: artist_name.into(),
                collection_name: item.collection_name.clone(),
                artwork_url: high_res,
                score: (artist_sim * 100.0).round(),
                accepted: false,
                rejection_reason: Some(format!(
                    "Artist similarity too low ({}%)",
                    (artist_sim * 100.0).round() as u32
                )),
            });
            continue;
        }

        let c_flags = extract_edition_flags(&format!(
            "{} {}",
            track_name,
            item.collection_name.as_deref().unwrap_or("")
        ));
        let mut penalty = 0.0f64;
        if c_flags.live && !q_flags.live {
            penalty -= 20.0;
        }
        if c_flags.remix && !q_flags.remix {
            penalty -= 20.0;
        }
        if c_flags.acoustic && !q_flags.acoustic {
            penalty -= 15.0;
        }
        if c_flags.instrumental && !q_flags.instrumental {
            penalty -= 25.0;
        }

        let mut dur_bonus = 0.0f64;
        if let (Some(q_ms), Some(c_ms)) = (query.duration_ms, item.track_time_millis) {
            let delta_sec = (q_ms - c_ms).abs() as f64 / 1000.0;
            if (delta_sec > 90.0 && title_sim < 0.92) || (delta_sec > 45.0 && title_sim < 0.78) {
                out.push(ScoredItunesCandidate {
                    title: track_name.into(),
                    artist: artist_name.into(),
                    collection_name: item.collection_name.clone(),
                    artwork_url: high_res,
                    score: (title_sim * 50.0 + artist_sim * 30.0).round(),
                    accepted: false,
                    rejection_reason: Some(format!(
                        "Duration delta {}s exceeds threshold",
                        delta_sec.round() as u32
                    )),
                });
                continue;
            }
            dur_bonus = if delta_sec > 45.0 {
                -10.0
            } else {
                (1.0 - delta_sec / 25.0).max(0.0) * 10.0
            };
        }

        let mut album_bonus = 0.0f64;
        if has_album {
            if let Some(col) = item.collection_name.as_deref() {
                if compute_string_similarity(&query.album, col) > 0.75 {
                    album_bonus = 10.0;
                }
            }
        }

        let base_score = if has_artist {
            title_sim * 50.0 + artist_sim * 30.0 + dur_bonus + album_bonus + penalty
        } else {
            title_sim * 70.0 + dur_bonus + album_bonus + penalty
        };

        let rounded = ((base_score * 10.0).round() / 10.0).max(0.0);
        let accepted = base_score >= 40.0;
        out.push(ScoredItunesCandidate {
            title: track_name.into(),
            artist: artist_name.into(),
            collection_name: item.collection_name.clone(),
            artwork_url: high_res,
            score: rounded,
            accepted,
            rejection_reason: if accepted {
                None
            } else {
                Some(format!(
                    "Score {} below minimum 40",
                    base_score.round() as i32
                ))
            },
        });
    }

    out.sort_by(|a, b| {
        b.accepted
            .cmp(&a.accepted)
            .then_with(|| b.score.total_cmp(&a.score))
    });
    out
}

pub fn rank_itunes_albums(
    query: &ArtworkQuery,
    items: &[ItunesCandidateInput],
) -> Vec<ScoredItunesCandidate> {
    if !has_meaningful_album(&query.album) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let q_flags = extract_edition_flags(&query.album);
    let has_artist = !query.artist.trim().is_empty();
    let size_re = Regex::new(r"/\d+x\d+bb\.").unwrap();

    for item in items {
        let Some(col_name) = item.collection_name.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(art100) = item.artwork_url100.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        let artist_name = item.artist_name.as_deref().unwrap_or("");
        let album_sim = compute_string_similarity(&query.album, col_name);
        let artist_sim = if has_artist && !artist_name.is_empty() {
            compute_itunes_artist_similarity(&query.artist, artist_name)
        } else {
            1.0
        };
        let high_res = size_re.replace(art100, "/600x600bb.").to_string();

        if album_sim < 0.68 || (has_artist && artist_sim < 0.55) {
            out.push(ScoredItunesCandidate {
                title: col_name.into(),
                artist: artist_name.into(),
                collection_name: Some(col_name.into()),
                artwork_url: high_res,
                score: (album_sim.min(artist_sim) * 100.0).round(),
                accepted: false,
                rejection_reason: Some(if has_artist && artist_sim < 0.55 {
                    format!(
                        "Artist similarity too low ({}%)",
                        (artist_sim * 100.0).round() as u32
                    )
                } else {
                    format!(
                        "Album similarity too low ({}%)",
                        (album_sim * 100.0).round() as u32
                    )
                }),
            });
            continue;
        }

        let c_flags = extract_edition_flags(col_name);
        let mut penalty = 0.0f64;
        if c_flags.live && !q_flags.live {
            penalty -= 20.0;
        }
        if c_flags.remix && !q_flags.remix {
            penalty -= 20.0;
        }
        if c_flags.instrumental && !q_flags.instrumental {
            penalty -= 25.0;
        }

        let score = if has_artist {
            album_sim * 52.0 + artist_sim * 38.0 + penalty
        } else {
            album_sim * 80.0 + penalty
        };
        let rounded = ((score * 10.0).round() / 10.0).max(0.0);
        let accepted = score >= 50.0;
        out.push(ScoredItunesCandidate {
            title: col_name.into(),
            artist: artist_name.into(),
            collection_name: Some(col_name.into()),
            artwork_url: high_res,
            score: rounded,
            accepted,
            rejection_reason: if accepted {
                None
            } else {
                Some(format!(
                    "Album score {} below minimum 50",
                    score.round() as i32
                ))
            },
        });
    }

    out.sort_by(|a, b| {
        b.accepted
            .cmp(&a.accepted)
            .then_with(|| b.score.total_cmp(&a.score))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_youtube_noise_and_extracts_artist_from_title() {
        let raw = ArtworkQuery {
            id: "t1".into(),
            title: "Sade - Smooth Operator (Official Video) [HD]".into(),
            artist: "7clouds".into(),
            album: "Single".into(),
            duration_ms: Some(258_000),
        };
        let norm = normalize_metadata_query(&raw);
        assert_eq!(norm.artist, "Sade");
        assert_eq!(norm.title, "Smooth Operator");
        assert_eq!(norm.album, "");
    }

    #[test]
    fn scores_musicbrainz_release_groups_and_rejects_wrong_artist_or_live_compilations() {
        let query = ArtworkQuery {
            id: "t1".into(),
            title: "Get Lucky".into(),
            artist: "Daft Punk".into(),
            album: "Random Access Memories".into(),
            duration_ms: Some(248_000),
        };
        let studio = MbReleaseGroup {
            id: "11111111-2222-3333-4444-555555555555".into(),
            title: "Random Access Memories".into(),
            primary_type: Some("Album".into()),
            secondary_types: vec![],
            disambiguation: None,
            artist_credit: vec![MbArtistCredit {
                name: Some("Daft Punk".into()),
                joinphrase: None,
                artist: None,
            }],
            releases: vec![],
        };
        let scored_studio = score_release_group(&studio, &query);
        assert!(scored_studio.accepted);
        assert!(scored_studio.confidence >= 90);

        let wrong_artist = MbReleaseGroup {
            artist_credit: vec![MbArtistCredit {
                name: Some("Tribute Band".into()),
                joinphrase: None,
                artist: None,
            }],
            ..studio.clone()
        };
        let scored_wrong = score_release_group(&wrong_artist, &query);
        assert!(!scored_wrong.accepted);

        let compilation = MbReleaseGroup {
            title: "Totally Unrelated Compilation".into(),
            primary_type: Some("Album".into()),
            secondary_types: vec!["Compilation".into()],
            artist_credit: vec![MbArtistCredit {
                name: Some("Various Artists".into()),
                joinphrase: None,
                artist: None,
            }],
            ..studio
        };
        assert!(!score_release_group(&compilation, &query).accepted);
    }

    #[test]
    fn ranks_itunes_results_and_rejects_mismatched_durations_or_artists() {
        let query = ArtworkQuery {
            id: "t1".into(),
            title: "Midnight City".into(),
            artist: "M83".into(),
            album: "Hurry Up, We're Dreaming".into(),
            duration_ms: Some(243_000),
        };
        let good = ItunesCandidateInput {
            track_name: Some("Midnight City".into()),
            artist_name: Some("M83".into()),
            collection_name: Some("Hurry Up, We're Dreaming".into()),
            artwork_url100: Some(
                "https://is1-ssl.mzstatic.com/image/thumb/m83/100x100bb.jpg".into(),
            ),
            track_time_millis: Some(243_000),
        };
        let bad_artist = ItunesCandidateInput {
            track_name: Some("Midnight City".into()),
            artist_name: Some("Someone Else".into()),
            collection_name: Some("Other".into()),
            artwork_url100: Some(
                "https://is1-ssl.mzstatic.com/image/thumb/bad/100x100bb.jpg".into(),
            ),
            track_time_millis: Some(243_000),
        };
        let ranked = rank_itunes_songs(&query, &[bad_artist, good]);
        let accepted: Vec<_> = ranked.iter().filter(|c| c.accepted).collect();
        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted[0].artist, "M83");
        assert!(accepted[0].artwork_url.contains("600x600bb.jpg"));
    }
}
