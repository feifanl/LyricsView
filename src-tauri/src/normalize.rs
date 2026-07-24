// Track normalization + cache keying. Pure functions with unit tests.
//
// Cache key = sha1(normalizedArtist + "|" + normalizedTitle + "|" + durationRoundedTo2s).
use sha1::{Digest, Sha1};

use crate::model::TrackInfo;

/// Fold Traditional Chinese to Simplified, lowercase, strip feat. clauses and
/// bracketed suffixes, collapse whitespace.
///
/// The Traditional→Simplified fold is essential: players surface metadata in
/// Traditional (YouTube Music shows "光輝歲月" / album "命運派對") while the
/// providers' catalogs are Simplified ("光辉岁月" / "命运派对"). Without folding,
/// the same song scores as only ~50% similar across scripts, so matching picks
/// the wrong release (or nothing). ASCII text is untouched by the fold.
pub fn normalize(input: &str) -> String {
    let simplified = fast2s::convert(input);
    let lower = simplified.to_lowercase();
    let no_brackets = strip_bracketed(&lower);
    let no_feat = strip_feat(&no_brackets);
    collapse_ws(&no_feat)
}

/// Remove parenthesised/bracketed suffixes: "(Remastered 2011)", "[Live]", etc.
fn strip_bracketed(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth: i32 = 0;
    for c in s.chars() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                if depth > 0 {
                    depth -= 1;
                }
            }
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

/// Remove "feat./ft./featuring …" clauses (to end of string).
fn strip_feat(s: &str) -> String {
    const MARKERS: [&str; 4] = [" feat.", " feat ", " ft.", " featuring "];
    let mut cut = s.len();
    for m in MARKERS {
        if let Some(idx) = s.find(m) {
            cut = cut.min(idx);
        }
    }
    s[..cut].to_string()
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn track_key(track: &TrackInfo) -> String {
    let artist = normalize(&track.artist);
    let title = normalize(&track.title);
    let dur_bucket = ((track.duration_ms as f64 / 1000.0 / 2.0).round() as u64) * 2;
    let raw = format!("{artist}|{title}|{dur_bucket}");
    let mut hasher = Sha1::new();
    hasher.update(raw.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_traditional_to_simplified() {
        // YouTube Music (Traditional) must normalize to the same string as the
        // providers' Simplified catalog entries.
        assert_eq!(normalize("光輝歲月"), normalize("光辉岁月"));
        assert_eq!(normalize("命運派對"), normalize("命运派对"));
    }

    #[test]
    fn strips_feat_and_brackets() {
        assert_eq!(
            normalize("Never Gonna Give You Up (Remastered 2011)"),
            "never gonna give you up"
        );
        assert_eq!(normalize("Song feat. Someone"), "song");
        assert_eq!(normalize("Track ft. X & Y"), "track");
        assert_eq!(normalize("A  B   C"), "a b c");
    }

    #[test]
    fn key_buckets_duration_to_2s() {
        let mk = |d| TrackInfo {
            title: "T".into(),
            artist: "A".into(),
            album: String::new(),
            duration_ms: d,
            source_app_id: String::new(),
        };
        // 200_000ms and 199_500ms both bucket to 200s.
        assert_eq!(track_key(&mk(200_000)), track_key(&mk(199_500)));
        // 210_000ms buckets to 210s -> different key.
        assert_ne!(track_key(&mk(200_000)), track_key(&mk(210_000)));
    }
}
