// Standard LRC and Enhanced LRC (inline `<mm:ss.xx>` word tags) parser.
//
// Handles: multiple `[mm:ss.xx]` timestamps per line, `[offset:±ms]` tags,
// metadata tags (`[ar:]`, `[ti:]`, …) which are ignored, out-of-order lines
// (sorted by start), and malformed timestamps (line skipped, never panics).
use crate::lyrics::{LyricLine, LyricWord, LyricsDoc, ParseError, SourceId};

/// Default duration (ms) for the final line when nothing follows it.
const TRAILING_LINE_MS: u64 = 4000;

/// Format ms as an LRC `[mm:ss.xx]` timestamp (centiseconds).
fn fmt_ts(ms: u64, open: char, close: char) -> String {
    let cs = (ms % 1000) / 10;
    let s = (ms / 1000) % 60;
    let m = ms / 60_000;
    format!("{open}{m:02}:{s:02}.{cs:02}{close}")
}

/// Serialize a document back to LRC. Word timings, when present, are preserved
/// as Enhanced-LRC inline `<mm:ss.xx>` tags.
pub fn serialize_lrc(doc: &LyricsDoc) -> String {
    let mut out = String::new();
    for line in &doc.lines {
        out.push_str(&fmt_ts(line.start, '[', ']'));
        match &line.words {
            Some(words) if !words.is_empty() => {
                for w in words {
                    out.push_str(&fmt_ts(w.start, '<', '>'));
                    out.push_str(&w.text);
                }
            }
            _ => out.push_str(&line.text),
        }
        out.push('\n');
    }
    out
}

struct RawLine {
    start: u64,
    text: String,
    words: Option<Vec<LyricWord>>,
}

pub fn parse_lrc(text: &str, source: SourceId, track_key: &str) -> Result<LyricsDoc, ParseError> {
    let mut offset_ms: i64 = 0;
    let mut raw: Vec<RawLine> = Vec::new();
    let mut plain_lines: Vec<String> = Vec::new();

    for line in text.lines() {
        let (stamps, rest, line_offset) = scan_leading_tags(line);
        if let Some(o) = line_offset {
            offset_ms = o;
        }
        if stamps.is_empty() {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                plain_lines.push(trimmed.to_string());
            }
            continue;
        }

        // Enhanced-LRC word tags present?
        if rest.contains('<') {
            if let Some((clean, words)) = parse_word_tags(&rest) {
                // Word timings are absolute; use the first line stamp.
                raw.push(RawLine {
                    start: stamps[0],
                    text: clean,
                    words: Some(words),
                });
                continue;
            }
        }

        let clean = rest.trim().to_string();
        for &s in &stamps {
            raw.push(RawLine {
                start: s,
                text: clean.clone(),
                words: None,
            });
        }
    }

    if raw.is_empty() {
        if plain_lines.is_empty() {
            return Err(ParseError::NoTimestamps);
        }
        return Ok(LyricsDoc::plain_only(source, track_key, plain_lines.join("\n")));
    }

    // Apply the file offset, then sort by start.
    for r in &mut raw {
        r.start = apply_offset(r.start, offset_ms);
        if let Some(words) = &mut r.words {
            for w in words {
                w.start = apply_offset(w.start, offset_ms);
                w.end = apply_offset(w.end, offset_ms);
            }
        }
    }
    raw.sort_by_key(|r| r.start);

    let has_word_timing = raw.iter().any(|r| r.words.is_some());
    let mut lines: Vec<LyricLine> = raw
        .into_iter()
        .map(|r| LyricLine {
            start: r.start,
            end: 0,
            text: r.text,
            words: r.words,
            translation: None,
        })
        .collect();
    // End times: next line's start; last line gets a trailing default.
    for i in 0..lines.len() {
        let end = if i + 1 < lines.len() {
            lines[i + 1].start
        } else {
            lines[i].start + TRAILING_LINE_MS
        };
        lines[i].end = end.max(lines[i].start);
        if let Some(words) = lines[i].words.take() {
            let fixed = fill_word_ends(words, lines[i].end);
            lines[i].words = Some(fixed);
        }
    }

    Ok(LyricsDoc {
        source,
        track_key: track_key.to_string(),
        lines,
        plain: None,
        has_word_timing,
    })
}

fn apply_offset(t: u64, offset_ms: i64) -> u64 {
    (t as i64 + offset_ms).max(0) as u64
}

/// Word end = next word's start; the last word ends with the line.
fn fill_word_ends(mut words: Vec<LyricWord>, line_end: u64) -> Vec<LyricWord> {
    let n = words.len();
    for i in 0..n {
        let end = if i + 1 < n { words[i + 1].start } else { line_end };
        words[i].end = end.max(words[i].start);
    }
    words
}

/// Parse leading `[...]` groups. Returns (timestamps_ms, remaining_text, offset).
fn scan_leading_tags(line: &str) -> (Vec<u64>, String, Option<i64>) {
    let mut stamps = Vec::new();
    let mut offset = None;
    let mut rest = line;
    loop {
        let rest_trimmed = rest.trim_start();
        if !rest_trimmed.starts_with('[') {
            rest = rest_trimmed;
            break;
        }
        let Some(close) = rest_trimmed.find(']') else {
            rest = rest_trimmed;
            break;
        };
        let inner = &rest_trimmed[1..close];
        let after = &rest_trimmed[close + 1..];
        if let Some(ms) = parse_time(inner) {
            stamps.push(ms);
            rest = after;
        } else if let Some(v) = inner.strip_prefix("offset:") {
            offset = v.trim().parse::<i64>().ok();
            rest = after;
        } else {
            // Metadata tag ([ar:], [ti:], …) — consume and ignore.
            rest = after;
        }
    }
    (stamps, rest.to_string(), offset)
}

/// Parse "mm:ss.xx" / "mm:ss.xxx" / "mm:ss" (also tolerates "mm:ss:xx").
fn parse_time(s: &str) -> Option<u64> {
    let s = s.trim();
    if !s.chars().next()?.is_ascii_digit() {
        return None;
    }
    let (min_str, tail) = s.split_once(':')?;
    let minutes: u64 = min_str.parse().ok()?;

    let (sec_str, frac_str) = if let Some((a, b)) = tail.split_once('.') {
        (a, Some(b))
    } else if let Some((a, b)) = tail.split_once(':') {
        (a, Some(b))
    } else {
        (tail, None)
    };
    let seconds: u64 = sec_str.parse().ok()?;
    let frac_ms = match frac_str {
        None => 0,
        Some(f) => {
            let digits: String = f.chars().take_while(|c| c.is_ascii_digit()).collect();
            if digits.is_empty() {
                return None;
            }
            let val: u64 = digits.parse().ok()?;
            match digits.len() {
                1 => val * 100,
                2 => val * 10,
                3 => val,
                _ => val / 10u64.pow(digits.len() as u32 - 3),
            }
        }
    };
    Some(minutes * 60_000 + seconds * 1000 + frac_ms)
}

/// Parse `<time>word <time>word …` into (clean_text, words). Word ends are left
/// as 0 (filled once the line end is known). Returns None if no word tags parse.
fn parse_word_tags(s: &str) -> Option<(String, Vec<LyricWord>)> {
    let mut words: Vec<LyricWord> = Vec::new();
    let mut clean = String::new();
    let mut rest = s;

    // Skip any leading text before the first tag (kept in clean output).
    while let Some(open) = rest.find('<') {
        let lead = &rest[..open];
        clean.push_str(lead);
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('>') else {
            break;
        };
        let time_str = &after_open[..close];
        let content_start = &after_open[close + 1..];
        // Text runs until the next '<' or end of string.
        let next = content_start.find('<').unwrap_or(content_start.len());
        let word_text = &content_start[..next];

        if let Some(start) = parse_time(time_str) {
            words.push(LyricWord {
                start,
                end: 0,
                text: word_text.to_string(),
            });
            clean.push_str(word_text);
        } else {
            // Not a timestamp inside <>; keep literally.
            clean.push('<');
            clean.push_str(time_str);
            clean.push('>');
            clean.push_str(word_text);
        }
        rest = &content_start[next..];
    }
    clean.push_str(rest);

    if words.is_empty() {
        None
    } else {
        Some((clean.trim().to_string(), words))
    }
}
