// NetEase Cloud Music (unofficial) — `yrc` word-level, strong CJK catalog.
//
// UNOFFICIAL: isolated and fail-soft like Musixmatch. Requires a
// `Referer: https://music.163.com` header and a browser-ish UA.
use reqwest::Client;
use serde_json::Value;

use crate::lyrics::{LyricLine, LyricsDoc, SourceId};
use crate::matching::best_match;
use crate::model::{SearchCandidate, TrackInfo};
use crate::parse::{parse_lrc, parse_yrc};

use super::Provider;

const REFERER: &str = "https://music.163.com";

pub struct Netease;

impl Provider for Netease {
    async fn fetch(&self, http: &Client, track: &TrackInfo) -> Option<LyricsDoc> {
        let key = crate::normalize::track_key(track);
        let query = format!("{} {}", track.title, track.artist);
        let candidates = self.search(http, &query).await;
        let idx = best_match(track, &candidates)?;
        let id = candidates.get(idx)?.id.clone();
        self.lyric_doc(http, &id, &key).await
    }

    async fn search(&self, http: &Client, query: &str) -> Vec<SearchCandidate> {
        let resp = http
            .post(format!("{REFERER}/api/cloudsearch/pc"))
            .header("Referer", REFERER)
            .form(&[("s", query), ("type", "1"), ("limit", "10")])
            .send()
            .await;
        let Ok(v) = (match resp {
            Ok(r) => r.json::<Value>().await,
            Err(_) => return Vec::new(),
        }) else {
            return Vec::new();
        };
        let Some(songs) = v
            .get("result")
            .and_then(|r| r.get("songs"))
            .and_then(Value::as_array)
        else {
            return Vec::new();
        };
        songs.iter().filter_map(candidate_from_song).collect()
    }

    async fn fetch_candidate(&self, http: &Client, cand: &SearchCandidate) -> Option<LyricsDoc> {
        let key = super::candidate_key(cand);
        self.lyric_doc(http, &cand.id, &key).await
    }
}

impl Netease {
    async fn lyric_doc(&self, http: &Client, id: &str, key: &str) -> Option<LyricsDoc> {
        let v = http
            .get(format!("{REFERER}/api/song/lyric/v1"))
            .header("Referer", REFERER)
            .query(&[
                ("id", id),
                ("cp", "false"),
                ("lv", "0"),
                ("kv", "0"),
                ("tv", "0"),
                ("rv", "0"),
                ("yv", "0"),
            ])
            .send()
            .await
            .ok()?
            .json::<Value>()
            .await
            .ok()?;

        let yrc = v.get("yrc").and_then(|y| y.get("lyric")).and_then(Value::as_str);
        let lrc = v.get("lrc").and_then(|l| l.get("lyric")).and_then(Value::as_str);
        let tlyric = v
            .get("tlyric")
            .and_then(|t| t.get("lyric"))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty());

        let mut doc = if let Some(yrc) = yrc.filter(|s| !s.trim().is_empty()) {
            parse_yrc(yrc, key).ok()?
        } else {
            parse_lrc(lrc?, SourceId::Netease, key).ok()?
        };

        // Instrumental tracks come back as a single placeholder line
        // ("纯音乐，请欣赏" = "instrumental, please enjoy"). That's not lyrics —
        // treat it as a miss so the overlay shows "no lyrics" instead of freezing
        // on the placeholder (which reads as leftover lyrics from another song).
        if is_instrumental_placeholder(&doc.lines) {
            return None;
        }

        // Attach NetEase's bundled translation (tlyric) per line, if present.
        if let Some(tlyric) = tlyric {
            if let Ok(tdoc) = parse_lrc(tlyric, SourceId::Netease, key) {
                attach_translations(&mut doc.lines, &tdoc.lines);
            }
        }
        Some(doc)
    }
}

/// True when the parsed lyrics are just NetEase's instrumental placeholder
/// (a lone "纯音乐，请欣赏" line, ignoring CJK/ASCII punctuation and spacing).
fn is_instrumental_placeholder(lines: &[LyricLine]) -> bool {
    let joined: String = lines
        .iter()
        .flat_map(|l| l.text.chars())
        .filter(|c| c.is_alphanumeric()) // drop punctuation/spaces (，, spaces…)
        .collect();
    joined == "纯音乐请欣赏"
}

/// Match translation lines to main lines by nearest start time (±500 ms).
fn attach_translations(main: &mut [LyricLine], trans: &[LyricLine]) {
    for line in main.iter_mut() {
        let best = trans
            .iter()
            .min_by_key(|t| t.start.abs_diff(line.start));
        if let Some(t) = best {
            if t.start.abs_diff(line.start) <= 500 && !t.text.trim().is_empty() {
                line.translation = Some(t.text.clone());
            }
        }
    }
}

fn candidate_from_song(song: &Value) -> Option<SearchCandidate> {
    let id = song.get("id")?.as_i64()?;
    let artist = song
        .get("ar")
        .and_then(Value::as_array)
        .map(|ar| {
            ar.iter()
                .filter_map(|a| a.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    Some(SearchCandidate {
        source: SourceId::Netease,
        id: id.to_string(),
        title: song.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
        artist,
        album: song
            .get("al")
            .and_then(|a| a.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        duration_ms: song.get("dt").and_then(Value::as_i64).map(|d| d as u64),
        has_word_timing: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str) -> LyricLine {
        LyricLine::new(0, 0, text.to_string())
    }

    #[test]
    fn detects_instrumental_placeholder() {
        assert!(is_instrumental_placeholder(&[line("纯音乐，请欣赏")]));
        assert!(is_instrumental_placeholder(&[line("纯音乐, 请欣赏")]));
    }

    #[test]
    fn real_lyrics_are_not_placeholder() {
        assert!(!is_instrumental_placeholder(&[line("纯音乐"), line("真正的歌词")]));
        assert!(!is_instrumental_placeholder(&[line("hello world")]));
        assert!(!is_instrumental_placeholder(&[]));
    }
}
