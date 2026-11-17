use super::{Line, Record, Word};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

static STAMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{1,3}):(\d{1,2})(?:[.:,](\d{1,3}))?$").unwrap());
static WORD_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<([^<>]+)>").unwrap());
static META: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[([a-zA-Z]+):([^\]]*)\]$").unwrap());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedLyrics {
    pub lines: Vec<Line>,
    pub format: String,
    pub skipped_lines: usize,
}

fn timestamp(text: &str) -> Option<i64> {
    let caps = STAMP.captures(text)?;
    let minutes = caps[1].parse::<i64>().ok()?;
    let seconds = caps[2].parse::<i64>().ok()?;
    if seconds >= 60 {
        return None;
    }
    let fraction = caps.get(3).map_or("", |m| m.as_str());
    let ms = if fraction.is_empty() {
        0
    } else {
        fraction.parse::<i64>().ok()? * 10_i64.pow((3 - fraction.len()) as u32)
    };
    Some(minutes * 60_000 + seconds * 1000 + ms)
}

fn words(text: &str) -> (String, Vec<Word>) {
    let marks: Vec<_> = WORD_TAG
        .captures_iter(text)
        .filter_map(|c| Some((c.get(0)?, timestamp(&c[1])?)))
        .collect();
    if marks.is_empty() {
        return (text.to_string(), Vec::new());
    }
    let mut plain = text[..marks[0].0.start()].to_string();
    let mut words = Vec::new();
    for (i, (mark, start)) in marks.iter().enumerate() {
        let next = marks.get(i + 1);
        let part = &text[mark.end()..next.map_or(text.len(), |m| m.0.start())];
        plain.push_str(part);
        words.push(Word {
            text: part.into(),
            start_ms: *start,
            end_ms: next.map(|m| m.1),
        });
    }
    if words.windows(2).any(|w| w[0].start_ms > w[1].start_ms) {
        words.clear(); // inconsistent word timing: retain line timing and text
    }
    if !words.iter().any(|w| !w.text.trim().is_empty()) {
        words.clear();
    }
    (plain, words)
}

pub fn parse(content: &str) -> ParsedLyrics {
    let content = content.trim_start_matches('\u{feff}');
    if let Some(lines) = parse_lyricsfile(content) {
        return ParsedLyrics {
            lines,
            format: "lrc".into(),
            skipped_lines: 0,
        };
    }
    let source: Vec<_> = content
        .trim_start_matches('\u{feff}')
        .split(['\r', '\n'])
        .collect();
    // Offset tags can appear after the lyrics; apply once after parsing, to
    // line and genuine word timestamps alike. User offsets remain separate.
    let offset = source
        .iter()
        .filter_map(|raw| {
            let c = META.captures(raw.trim())?;
            if c[1].eq_ignore_ascii_case("offset") {
                c[2].trim().parse::<i64>().ok()
            } else {
                None
            }
        })
        .next_back()
        .unwrap_or(0)
        .clamp(-86_400_000, 86_400_000);
    let mut lines = Vec::new();
    let mut skipped = 0;
    for raw in &source {
        let mut rest = raw.trim();
        if rest.is_empty() || META.is_match(rest) {
            continue;
        }
        let mut times = Vec::new();
        while rest.starts_with('[') {
            let Some(end) = rest.find(']') else {
                break;
            };
            let Some(time) = timestamp(&rest[1..end]) else {
                break;
            };
            times.push(time);
            rest = rest[end + 1..].trim_start();
        }
        if times.is_empty() {
            skipped += 1;
            continue;
        }
        let (text, word_spans) = words(rest);
        for time in times {
            lines.push(Line {
                time_ms: Some((time - offset).max(0)),
                text: text.trim().into(),
                words: word_spans
                    .iter()
                    .map(|w| Word {
                        text: w.text.clone(),
                        start_ms: (w.start_ms - offset).max(0),
                        end_ms: w.end_ms.map(|end| (end - offset).max(0)),
                    })
                    .collect(),
            });
        }
    }
    if lines.is_empty() {
        return ParsedLyrics {
            lines: source
                .iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| Line {
                    text: s.into(),
                    ..Default::default()
                })
                .collect(),
            format: "txt".into(),
            skipped_lines: 0,
        };
    }
    lines.sort_by_key(|l| l.time_ms);
    ParsedLyrics {
        lines,
        format: "lrc".into(),
        skipped_lines: skipped,
    }
}

// The established lyricsfile contract is a bounded YAML-like subset, not a
// general YAML document (no aliases, executable tags, or arbitrary objects).
pub fn parse_lyricsfile(content: &str) -> Option<Vec<Line>> {
    let blocks: Vec<(usize, &str, &str)> = content
        .lines()
        .filter_map(|raw| {
            let indent = raw.len() - raw.trim_start().len();
            let trimmed = raw.trim_start();
            let (indent, trimmed) = if let Some(s) = trimmed.strip_prefix("- ") {
                (indent + 2, s)
            } else {
                (indent, trimmed)
            };
            let (key, value) = trimmed.split_once(':')?;
            Some((indent, key.trim(), value.trim()))
        })
        .collect();
    let start = blocks
        .iter()
        .position(|(i, k, v)| *i == 0 && *k == "lines" && v.is_empty())?;
    let unquote = |s: &str| -> String {
        if s.len() >= 2
            && ((s.starts_with('\'') && s.ends_with('\''))
                || (s.starts_with('"') && s.ends_with('"')))
        {
            s[1..s.len() - 1].to_string()
        } else {
            s.to_string()
        }
    };
    let mut lines = Vec::new();
    let mut i = start + 1;
    while i < blocks.len() && blocks[i].0 > 0 {
        let (indent, key, value) = blocks[i];
        if key != "text" {
            i += 1;
            continue;
        }
        let mut line = Line {
            text: unquote(value),
            ..Default::default()
        };
        i += 1;
        while i < blocks.len() && blocks[i].0 >= indent {
            let (depth, key, val) = blocks[i];
            if depth == indent && key == "text" {
                break;
            }
            if depth == indent && key == "start_ms" {
                line.time_ms = val.parse::<i64>().ok().filter(|n| *n >= 0);
            }
            if depth > indent && key == "text" {
                let mut word = Word {
                    text: unquote(val),
                    ..Default::default()
                };
                let mut start_ms = None;
                i += 1;
                while i < blocks.len() && blocks[i].0 == depth && blocks[i].1 != "text" {
                    match blocks[i].1 {
                        "start_ms" => {
                            start_ms = blocks[i].2.parse::<i64>().ok().filter(|n| *n >= 0)
                        }
                        "end_ms" => word.end_ms = blocks[i].2.parse::<i64>().ok(),
                        _ => (),
                    }
                    i += 1;
                }
                if let Some(start) = start_ms {
                    word.start_ms = start;
                    line.words.push(word);
                }
                continue;
            }
            i += 1;
        }
        line.time_ms?;
        sanitize_words(&mut line);
        lines.push(line);
    }
    lines.sort_by_key(|l| l.time_ms);
    if lines.is_empty() {
        None
    } else {
        Some(lines)
    }
}

fn sanitize_words(line: &mut Line) {
    let valid = line.words.iter().all(|w| {
        w.start_ms >= 0
            && w.end_ms.is_none_or(|end| end >= w.start_ms)
            && line.time_ms.is_none_or(|start| w.start_ms >= start)
    }) && !line.words.windows(2).any(|w| w[0].start_ms > w[1].start_ms);
    if !valid || line.time_ms.is_none() {
        line.words.clear();
    }
}

pub fn normalize_record(record: &mut Record) {
    if record.lines.is_empty() {
        if let Some(lines) = record.lyricsfile.as_deref().and_then(parse_lyricsfile) {
            record.lines = lines;
        } else {
            let synced = record.synced_lyrics.as_deref().map(parse);
            if let Some(parsed) = synced.filter(|p| p.format == "lrc") {
                record.lines = parsed.lines;
            } else if let Some(plain) = record.plain_lyrics.as_deref() {
                record.lines = plain
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .map(|l| Line {
                        text: l.trim().into(),
                        ..Default::default()
                    })
                    .collect();
            }
        }
    }
    record.lines.retain(|l| l.time_ms.is_none_or(|t| t >= 0));
    for line in &mut record.lines {
        sanitize_words(line);
    }
    // Keep static rows after timed rows, preserving equal timestamp order.
    record.lines.sort_by_key(|l| l.time_ms.unwrap_or(i64::MAX));
    record.has_word_sync = record
        .lines
        .iter()
        .any(|l| l.words.iter().any(|w| !w.text.trim().is_empty()));
    record.duration = record.duration.filter(|v| v.is_finite() && *v > 0.0);
}

pub fn capability(record: &Record) -> &'static str {
    if record.instrumental {
        return "instrumental";
    }
    if record.has_word_sync {
        return "word";
    }
    if record.lines.iter().any(|l| l.time_ms.is_some()) {
        return "line";
    }
    if record.lines.iter().any(|l| !l.text.trim().is_empty()) {
        return "plain";
    }
    "none"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_plain_malformed_duplicates_and_offsets() {
        let p = parse("[00:01.5][00:02,250]Hello\n[00:99]bad\n[00:01.500]same\n[offset:1000]");
        assert_eq!(
            p.lines.iter().map(|l| l.time_ms).collect::<Vec<_>>(),
            vec![Some(500), Some(500), Some(1250)]
        );
        assert_eq!(p.lines[1].text, "same");
        assert_eq!(p.skipped_lines, 1);
        assert_eq!(parse("plain\nlyrics").format, "txt");
        assert!(parse("").lines.is_empty());
        assert_eq!(parse("[99:xx]bad").format, "txt");
    }

    #[test]
    fn genuine_words_shift_with_lines_and_no_words_are_fabricated() {
        let p = parse("[00:01.000]<00:01.000>hello <00:01.500>world<00:02.000>\n[offset:500]");
        assert_eq!(p.lines[0].time_ms, Some(500));
        assert_eq!(p.lines[0].words[0].start_ms, 500);
        assert_eq!(p.lines[0].words[0].end_ms, Some(1000));
        assert_eq!(p.lines[0].words[1].end_ms, Some(1500));
        assert!(parse("[00:01]hello world").lines[0].words.is_empty());
        assert!(parse("[00:01]<00:02>a<00:01>b").lines[0].words.is_empty());
        assert_eq!(
            parse("[offset:5000]\n[00:01]<00:01>a").lines[0].words[0].start_ms,
            0
        );
    }

    #[test]
    fn malformed_synced_payload_does_not_create_fake_plain_lyrics() {
        let mut record = Record {
            synced_lyrics: Some("[99:xx]broken".into()),
            ..Default::default()
        };
        normalize_record(&mut record);
        assert_eq!(capability(&record), "none");
        record.plain_lyrics = Some("Genuine plain fallback".into());
        normalize_record(&mut record);
        assert_eq!(capability(&record), "plain");
        assert_eq!(record.lines[0].text, "Genuine plain fallback");
    }

    #[test]
    fn structured_file_validates_real_word_timing() {
        let text = include_str!("../../tests/fixtures/word.lyricsfile");
        let lines = parse_lyricsfile(text).unwrap();
        assert_eq!(lines[0].words[1].start_ms, 1500);
        assert_eq!(lines[0].text, "hello world");
        assert!(parse_lyricsfile("lines:\n- text: missing time").is_none());
        let p = parse_lyricsfile("lines:\n- text: hi\n  start_ms: 1000\n  words:\n  - text: hi")
            .unwrap();
        assert!(p[0].words.is_empty());
    }
}
