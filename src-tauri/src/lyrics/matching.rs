use super::{parser, Record, TrackQuery};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

static BRACKETS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\([^()]*\)|\[[^\[\]]*\]|\{[^{}]*\}").unwrap());
static FEAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s+\b(?:feat|ft|featuring)\.?\s+.*$").unwrap());
static NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:official music video|official video|music video|lyric video|lyrics video|official audio)\b|\s+(?:topic|vevo)$").unwrap()
});
static COLLAB: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\s+(?:feat|ft|featuring)\.?\s+|\s+(?:&|x|with|vs\.?|dan|and)\s+|\s*,\s*")
        .unwrap()
});
const VERSIONS: &[&str] = &[
    "live",
    "acoustic",
    "remix",
    "radio edit",
    "instrumental",
    "acapella",
    "orchestral",
    "unplugged",
    "demo",
    "cover",
    "extended",
];

pub fn normalize(s: &str) -> String {
    let s: String = s
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .collect();
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn canonical(s: &str) -> String {
    let normalized = normalize(s);
    let stripped = BRACKETS.replace_all(&normalized, " ");
    let stripped = FEAT.replace(&stripped, " ");
    let mut value = stripped.to_string();
    if let Some((head, tail)) = value.rsplit_once(" - ") {
        if [
            "remaster",
            "live",
            "deluxe",
            "version",
            "edit",
            "mono",
            "stereo",
            "anniversary",
            "edition",
            "acoustic",
            "demo",
            "remix",
            "video",
        ]
        .iter()
        .any(|v| tail.contains(v))
        {
            value = head.to_string();
        }
    }
    let value = NOISE.replace_all(&value, " ");
    let value: String = value
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect();
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        normalized
    } else {
        value
    }
}

pub fn similarity(a: &str, b: &str) -> f64 {
    let a = canonical(a);
    let b = canonical(b);
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let a: Vec<_> = a.chars().take(512).collect();
    let b: Vec<_> = b.chars().take(512).collect();
    let mut previous: Vec<_> = (0..=b.len()).collect();
    for (i, left) in a.iter().enumerate() {
        let mut current = vec![i + 1; b.len() + 1];
        for (j, right) in b.iter().enumerate() {
            current[j + 1] = (current[j] + 1)
                .min(previous[j + 1] + 1)
                .min(previous[j] + usize::from(left != right));
        }
        previous = current;
    }
    1.0 - previous[b.len()] as f64 / a.len().max(b.len()) as f64
}

fn artist_similarity(a: &str, b: &str) -> f64 {
    let primary_a = COLLAB.split(a).next().unwrap_or(a);
    let primary_b = COLLAB.split(b).next().unwrap_or(b);
    similarity(a, b).max(similarity(primary_a, primary_b) * 0.95)
}

fn versions(s: &str) -> Vec<&'static str> {
    let normalized = normalize(s);
    VERSIONS
        .iter()
        .copied()
        .filter(|v| {
            let pattern = format!(r"\b{}\b", regex::escape(v));
            Regex::new(&pattern).unwrap().is_match(&normalized)
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    pub score: f64,
    pub title_similarity: f64,
    pub artist_similarity: Option<f64>,
    pub album_similarity: Option<f64>,
    pub duration_delta_seconds: Option<f64>,
    pub version_mismatch: bool,
    pub rejected: bool,
    pub reject_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub record: Record,
    pub quality: Quality,
    pub capability: String,
    pub has_synced: bool,
    pub has_plain: bool,
    pub auto_acceptable: bool,
}

fn duration_score(delta: f64) -> f64 {
    if delta <= 2.0 {
        1.0 - delta * 0.015
    } else if delta <= 5.0 {
        0.92 - ((delta - 2.0) / 3.0) * 0.07
    } else if delta <= 15.0 {
        0.80 - ((delta - 5.0) / 10.0) * 0.25
    } else if delta <= 60.0 {
        0.55 - ((delta - 15.0) / 45.0) * 0.35
    } else {
        0.0
    }
}

pub fn evaluate(track: &TrackQuery, record: &Record) -> Quality {
    let title = record.track_name.as_deref().unwrap_or("");
    let artist = record.artist_name.as_deref().unwrap_or("");
    let mut title_sim = similarity(&track.title, title);
    let artist_sim = if track.artist.is_empty() || artist.is_empty() {
        None
    } else {
        Some(artist_similarity(&track.artist, artist))
    };
    let album_sim = record
        .album_name
        .as_deref()
        .filter(|a| !a.is_empty() && !track.album.is_empty())
        .map(|a| similarity(&track.album, a));
    let delta = track
        .duration_ms
        .zip(record.duration)
        .map(|(ms, secs)| (ms as f64 / 1000.0 - secs).abs());
    let local_versions = versions(&track.title);
    let remote_versions = versions(title);
    let version_mismatch = local_versions != remote_versions;
    if version_mismatch {
        title_sim = title_sim.min(0.6);
    }
    let mut score = title_sim * 45.0;
    let mut weight = 45.0;
    if let Some(artist) = artist_sim {
        score += artist * 40.0;
        weight += 40.0;
    }
    if let Some(delta) = delta {
        score += duration_score(delta) * 15.0;
        weight += 15.0;
    }
    if let Some(album) = album_sim.filter(|s| *s >= 0.5) {
        score += album * 5.0;
        weight += 5.0;
    }
    let reject_reason = if title_sim < 0.5 {
        Some("Title does not match.")
    } else if title_sim < 0.75 && artist_sim.is_some_and(|a| a < 0.4) {
        Some("Neither title nor artist matches.")
    } else if delta.is_some_and(|d| d > 60.0) {
        Some("Duration differs by more than 60 seconds.")
    } else {
        None
    };
    Quality {
        score: (score / weight * 1000.0).round() / 10.0,
        title_similarity: title_sim,
        artist_similarity: artist_sim,
        album_similarity: album_sim,
        duration_delta_seconds: delta,
        version_mismatch,
        rejected: reject_reason.is_some(),
        reject_reason: reject_reason.map(String::from),
    }
}

fn safe(track: &TrackQuery, q: &Quality) -> bool {
    !q.rejected && !q.version_mismatch && q.score >= 80.0 && q.title_similarity >= 0.85
        // Missing artist identity is ambiguous on desktop: never silently choose
        // among covers or recordings on title alone.
        && !track.artist.is_empty() && q.artist_similarity.is_some_and(|a| a >= 0.75)
        && q.duration_delta_seconds.is_none_or(|d| d <= 5.0)
}

pub fn is_safe_match(track: &TrackQuery, record: &Record) -> bool {
    safe(track, &evaluate(track, record))
}

pub fn capability_rank(cap: &str) -> u8 {
    match cap {
        "word" => 3,
        "line" => 2,
        "plain" => 1,
        _ => 0,
    }
}

pub fn rank(track: &TrackQuery, records: Vec<Record>) -> Vec<Candidate> {
    let mut unique: Vec<Candidate> = Vec::new();
    for mut record in records {
        parser::normalize_record(&mut record);
        let quality = evaluate(track, &record);
        let capability = parser::capability(&record).to_string();
        if quality.rejected
            || quality.title_similarity < 0.55
            || quality.score < 40.0
            || capability == "none"
        {
            continue;
        }
        let entry = Candidate {
            auto_acceptable: safe(track, &quality),
            has_synced: capability == "line" || capability == "word",
            has_plain: record.lines.iter().any(|l| !l.text.trim().is_empty()),
            record,
            quality,
            capability,
        };
        let duplicate = unique.iter().position(|e| {
            (e.record.provider == entry.record.provider && e.record.id == entry.record.id)
                || (canonical(e.record.track_name.as_deref().unwrap_or(""))
                    == canonical(entry.record.track_name.as_deref().unwrap_or(""))
                    && canonical(e.record.artist_name.as_deref().unwrap_or(""))
                        == canonical(entry.record.artist_name.as_deref().unwrap_or(""))
                    && versions(e.record.track_name.as_deref().unwrap_or(""))
                        == versions(entry.record.track_name.as_deref().unwrap_or(""))
                    && e.record
                        .duration
                        .zip(entry.record.duration)
                        .is_some_and(|(a, b)| (a - b).abs() <= 2.0)
                    && e.record
                        .lines
                        .iter()
                        .map(|l| l.text.trim())
                        .collect::<Vec<_>>()
                        == entry
                            .record
                            .lines
                            .iter()
                            .map(|l| l.text.trim())
                            .collect::<Vec<_>>())
        });
        if let Some(i) = duplicate {
            if better(&entry, &unique[i]).is_lt() {
                unique[i] = entry;
            }
        } else {
            unique.push(entry);
        }
    }
    unique.sort_by(better);
    // Equally plausible identities must be selected explicitly. Different
    // provider copies of the same recording were already collapsed above.
    if let Some(best) = unique.first() {
        let ambiguous = unique.iter().skip(1).any(|other| {
            other.auto_acceptable
                && best.auto_acceptable
                && (best.quality.score - other.quality.score).abs() < 3.0
                && (canonical(best.record.artist_name.as_deref().unwrap_or(""))
                    != canonical(other.record.artist_name.as_deref().unwrap_or(""))
                    || (best.record.provider == other.record.provider
                        && best.record.id != other.record.id)
                    || best
                        .record
                        .lines
                        .iter()
                        .map(|l| l.text.trim())
                        .collect::<Vec<_>>()
                        != other
                            .record
                            .lines
                            .iter()
                            .map(|l| l.text.trim())
                            .collect::<Vec<_>>())
        });
        if ambiguous {
            for entry in &mut unique {
                entry.auto_acceptable = false;
            }
        }
    }
    unique.truncate(12);
    unique
}

fn better(a: &Candidate, b: &Candidate) -> std::cmp::Ordering {
    b.auto_acceptable
        .cmp(&a.auto_acceptable)
        .then_with(|| capability_rank(&b.capability).cmp(&capability_rank(&a.capability)))
        .then_with(|| b.quality.score.total_cmp(&a.quality.score))
        .then_with(|| {
            a.quality
                .duration_delta_seconds
                .unwrap_or(f64::INFINITY)
                .total_cmp(&b.quality.duration_delta_seconds.unwrap_or(f64::INFINITY))
        })
        .then_with(|| a.record.provider.cmp(&b.record.provider))
        .then_with(|| a.record.id.to_string().cmp(&b.record.id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn track() -> TrackQuery {
        TrackQuery {
            id: "t".into(),
            title: "Gentle Rise".into(),
            artist: "Aurora Fields".into(),
            album: "Northern Lights".into(),
            duration_ms: Some(212000),
        }
    }
    fn record() -> Record {
        Record {
            id: 1.into(),
            provider: "lrclib".into(),
            track_name: Some("Gentle Rise".into()),
            artist_name: Some("Aurora Fields".into()),
            album_name: Some("Northern Lights".into()),
            duration: Some(212.0),
            synced_lyrics: Some("[00:01]text".into()),
            ..Default::default()
        }
    }
    #[test]
    fn exact_wrong_artist_missing_artist_and_duration_guards() {
        assert!(rank(&track(), vec![record()])[0].auto_acceptable);
        let mut wrong = record();
        wrong.artist_name = Some("Other Band".into());
        assert!(!rank(&track(), vec![wrong])[0].auto_acceptable);
        let mut bare = track();
        bare.artist.clear();
        assert!(!rank(&bare, vec![record()])[0].auto_acceptable);
        let mut long = record();
        long.duration = Some(238.0);
        assert!(!rank(&track(), vec![long])[0].auto_acceptable);
    }
    #[test]
    fn normalized_metadata_duplicates_and_version_identity() {
        assert_eq!(similarity("Beyoncé (2011 Remaster)", "Beyonce"), 1.0);
        let mut copy = record();
        copy.provider = "lrcmux".into();
        assert_eq!(rank(&track(), vec![record(), copy]).len(), 1);
        let mut live = record();
        live.id = 2.into();
        live.track_name = Some("Gentle Rise (Live)".into());
        let ranked = rank(&track(), vec![record(), live]);
        assert_eq!(ranked.len(), 2);
        assert!(ranked[0].auto_acceptable);
        assert!(!ranked[1].auto_acceptable);
    }
    #[test]
    fn conflicting_cross_provider_payloads_require_selection() {
        let mut other = record();
        other.provider = "lrcmux".into();
        other.synced_lyrics = Some("[00:02]Different recording".into());
        assert!(rank(&track(), vec![record(), other])
            .iter()
            .all(|c| !c.auto_acceptable));
    }

    #[test]
    fn ambiguous_recordings_require_selection() {
        let mut second = record();
        second.id = 2.into();
        second.synced_lyrics = Some("[00:02]different words".into());
        assert!(rank(&track(), vec![record(), second])
            .iter()
            .all(|c| !c.auto_acceptable));
    }
}
