// LRCLIB provider — the primary, official, clean public API.
// Line-level only (LRCLIB has no word-level timing); Enhanced-LRC inline tags
// are honoured if a file happens to contain them.
use reqwest::Client;
use serde::Deserialize;

use crate::lyrics::{LyricsDoc, SourceId};
use crate::matching::best_match;
use crate::model::{SearchCandidate, TrackInfo};
use crate::normalize::track_key;
use crate::parse::parse_lrc;

use super::Provider;

const BASE: &str = "https://lrclib.net/api";

#[derive(Debug, Deserialize)]
struct LrclibItem {
    id: i64,
    #[serde(rename = "trackName", default)]
    track_name: String,
    #[serde(rename = "artistName", default)]
    artist_name: String,
    #[serde(rename = "albumName", default)]
    album_name: String,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(rename = "plainLyrics", default)]
    plain_lyrics: Option<String>,
    #[serde(rename = "syncedLyrics", default)]
    synced_lyrics: Option<String>,
}

impl LrclibItem {
    fn to_candidate(&self) -> SearchCandidate {
        let has_word = self
            .synced_lyrics
            .as_ref()
            .map(|s| s.contains('<'))
            .unwrap_or(false);
        SearchCandidate {
            source: SourceId::Lrclib,
            id: self.id.to_string(),
            title: self.track_name.clone(),
            artist: self.artist_name.clone(),
            album: self.album_name.clone(),
            duration_ms: self.duration.map(|d| (d * 1000.0) as u64),
            has_word_timing: Some(has_word),
        }
    }

    fn into_doc(self, key: &str) -> Option<LyricsDoc> {
        if let Some(synced) = self.synced_lyrics.filter(|s| !s.trim().is_empty()) {
            if let Ok(doc) = parse_lrc(&synced, SourceId::Lrclib, key) {
                return Some(doc);
            }
        }
        if let Some(plain) = self.plain_lyrics.filter(|s| !s.trim().is_empty()) {
            return Some(LyricsDoc::plain_only(SourceId::Lrclib, key, plain));
        }
        None
    }
}

pub struct Lrclib;

impl Provider for Lrclib {
    fn id(&self) -> SourceId {
        SourceId::Lrclib
    }

    async fn fetch(&self, http: &Client, track: &TrackInfo) -> Option<LyricsDoc> {
        let key = track_key(track);

        // Exact match when a duration is known.
        if track.duration_ms > 0 && !track.title.is_empty() {
            let dur_s = (track.duration_ms / 1000).to_string();
            let resp = http
                .get(format!("{BASE}/get"))
                .query(&[
                    ("artist_name", track.artist.as_str()),
                    ("track_name", track.title.as_str()),
                    ("album_name", track.album.as_str()),
                    ("duration", dur_s.as_str()),
                ])
                .send()
                .await;
            if let Ok(r) = resp {
                if r.status().is_success() {
                    if let Ok(item) = r.json::<LrclibItem>().await {
                        if let Some(doc) = item.into_doc(&key) {
                            return Some(doc);
                        }
                    }
                }
            }
        }

        // Fuzzy search fallback, then rank.
        let items = self.raw_search(http, track).await;
        let candidates: Vec<SearchCandidate> = items.iter().map(LrclibItem::to_candidate).collect();
        let idx = best_match(track, &candidates)?;
        items.into_iter().nth(idx)?.into_doc(&key)
    }

    async fn search(&self, http: &Client, query: &str) -> Vec<SearchCandidate> {
        let resp = http
            .get(format!("{BASE}/search"))
            .query(&[("q", query)])
            .send()
            .await;
        match resp {
            Ok(r) => r
                .json::<Vec<LrclibItem>>()
                .await
                .unwrap_or_default()
                .iter()
                .map(LrclibItem::to_candidate)
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    async fn fetch_candidate(&self, http: &Client, cand: &SearchCandidate) -> Option<LyricsDoc> {
        let resp = http.get(format!("{BASE}/get/{}", cand.id)).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let item = resp.json::<LrclibItem>().await.ok()?;
        let key = candidate_key(cand);
        item.into_doc(&key)
    }
}

impl Lrclib {
    async fn raw_search(&self, http: &Client, track: &TrackInfo) -> Vec<LrclibItem> {
        let resp = http
            .get(format!("{BASE}/search"))
            .query(&[
                ("track_name", track.title.as_str()),
                ("artist_name", track.artist.as_str()),
            ])
            .send()
            .await;
        match resp {
            Ok(r) => r.json::<Vec<LrclibItem>>().await.unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    }
}

/// Cache key derived from a candidate's own metadata.
pub fn candidate_key(cand: &SearchCandidate) -> String {
    track_key(&TrackInfo {
        title: cand.title.clone(),
        artist: cand.artist.clone(),
        album: cand.album.clone(),
        duration_ms: cand.duration_ms.unwrap_or(0),
        source_app_id: String::new(),
    })
}
