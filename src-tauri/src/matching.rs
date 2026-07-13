// Track-matching heuristics shared by all providers. Pure + unit-tested.
//
// Candidates are scored by normalized title/artist similarity plus duration
// proximity (±3 s is a strong signal). A candidate whose known duration is off
// by more than 10 s from a known track duration is rejected outright.
use crate::model::{SearchCandidate, TrackInfo};
use crate::normalize::normalize;

const DURATION_REJECT_MS: i64 = 10_000;
const DURATION_STRONG_MS: f64 = 3_000.0;

/// Levenshtein-ratio similarity in [0, 1] over normalized strings.
pub fn similarity(a: &str, b: &str) -> f64 {
    let a = normalize(a);
    let b = normalize(b);
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let dist = levenshtein(&a, &b);
    let max = a.chars().count().max(b.chars().count());
    if max == 0 {
        return 1.0;
    }
    1.0 - (dist as f64 / max as f64)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Duration closeness score in [0, 1]; 1.0 for an exact match, ~0 at 10 s off.
fn duration_score(a_ms: u64, b_ms: u64) -> f64 {
    let diff = (a_ms as i64 - b_ms as i64).abs() as f64;
    (1.0 - diff / (DURATION_REJECT_MS as f64)).max(0.0)
}

/// Overall match score in [0, 1]. `None` if the candidate must be rejected.
pub fn score(track: &TrackInfo, cand: &SearchCandidate) -> Option<f64> {
    // Hard duration gate (only when both durations are known).
    if track.duration_ms > 0 {
        if let Some(cd) = cand.duration_ms {
            if (track.duration_ms as i64 - cd as i64).abs() > DURATION_REJECT_MS {
                return None;
            }
        }
    }

    let title = similarity(&track.title, &cand.title);
    let artist = similarity(&track.artist, &cand.artist);
    let dur = match (track.duration_ms, cand.duration_ms) {
        (t, Some(c)) if t > 0 => {
            let base = duration_score(t, c);
            // Extra reward for a very tight (<3 s) match.
            let tight = if (t as i64 - c as i64).abs() as f64 <= DURATION_STRONG_MS {
                0.15
            } else {
                0.0
            };
            (base + tight).min(1.0)
        }
        _ => 0.5, // unknown duration: neutral
    };

    Some(title * 0.5 + artist * 0.3 + dur * 0.2)
}

/// Pick the best-scoring candidate above a minimum confidence.
pub fn best_match(track: &TrackInfo, candidates: &[SearchCandidate]) -> Option<usize> {
    const MIN_SCORE: f64 = 0.5;
    candidates
        .iter()
        .enumerate()
        .filter_map(|(i, c)| score(track, c).map(|s| (i, s)))
        .filter(|(_, s)| *s >= MIN_SCORE)
        .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap())
        .map(|(i, _)| i)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lyrics::SourceId;

    fn cand(title: &str, artist: &str, dur: Option<u64>) -> SearchCandidate {
        SearchCandidate {
            source: SourceId::Lrclib,
            id: "1".into(),
            title: title.into(),
            artist: artist.into(),
            album: String::new(),
            duration_ms: dur,
            has_word_timing: None,
        }
    }

    fn track(title: &str, artist: &str, dur: u64) -> TrackInfo {
        TrackInfo {
            title: title.into(),
            artist: artist.into(),
            album: String::new(),
            duration_ms: dur,
            source_app_id: String::new(),
        }
    }

    #[test]
    fn similar_strings_score_high() {
        assert!(similarity("Never Gonna Give You Up", "never gonna give you up") > 0.99);
        assert!(similarity("Hello", "World") < 0.5);
    }

    #[test]
    fn rejects_duration_far_off() {
        let t = track("Song", "Artist", 200_000);
        assert!(score(&t, &cand("Song", "Artist", Some(230_000))).is_none());
    }

    #[test]
    fn picks_best_of_several() {
        let t = track("Never Gonna Give You Up", "Rick Astley", 213_000);
        let cands = vec![
            cand("Some Other Song", "Nobody", Some(180_000)),
            cand("Never Gonna Give You Up", "Rick Astley", Some(213_000)),
            cand("Never Gonna Give You Up (Live)", "Rick Astley", Some(220_000)),
        ];
        assert_eq!(best_match(&t, &cands), Some(1));
    }

    #[test]
    fn unknown_duration_still_matches_on_text() {
        let t = track("Bohemian Rhapsody", "Queen", 0);
        assert!(score(&t, &cand("Bohemian Rhapsody", "Queen", None)).unwrap() > 0.8);
    }
}
