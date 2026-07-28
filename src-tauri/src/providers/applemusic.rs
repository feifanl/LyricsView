// Apple Music (optional, off by default) — syllable TTML.
//
// Active only when the user supplies their own `media-user-token` + developer
// bearer token (from their Apple Music subscription). Isolated and fail-soft.
use reqwest::Client;
use serde_json::Value;

use crate::config::AppleMusicCfg;
use crate::lyrics::LyricsDoc;
use crate::matching::best_match;
use crate::model::{SearchCandidate, TrackInfo};
use crate::parse::parse_ttml;

use super::Provider;

const AMP: &str = "https://amp-api.music.apple.com/v1/catalog";

pub struct AppleMusic {
    developer_token: String,
    media_user_token: String,
    storefront: String,
}

impl AppleMusic {
    pub fn new(cfg: &AppleMusicCfg) -> Self {
        Self {
            developer_token: cfg.developer_token.clone(),
            media_user_token: cfg.media_user_token.clone(),
            storefront: if cfg.storefront.is_empty() {
                "us".into()
            } else {
                cfg.storefront.clone()
            },
        }
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.header("Authorization", format!("Bearer {}", self.developer_token))
            .header("Music-User-Token", &self.media_user_token)
            .header("Origin", "https://music.apple.com")
    }

    async fn syllable_doc(
        &self,
        http: &Client,
        id: &str,
        key: &str,
        src_dur: Option<u64>,
    ) -> Option<LyricsDoc> {
        let url = format!("{AMP}/{}/songs/{id}/syllable-lyrics", self.storefront);
        let v = self
            .auth(http.get(url))
            .send()
            .await
            .ok()?
            .json::<Value>()
            .await
            .ok()?;
        let ttml = v
            .get("data")
            .and_then(Value::as_array)
            .and_then(|d| d.first())
            .and_then(|d| d.get("attributes"))
            .and_then(|a| a.get("ttml"))
            .and_then(Value::as_str)?;
        Some(parse_ttml(ttml, key).ok()?.with_source_duration(src_dur))
    }
}

impl Provider for AppleMusic {
    async fn fetch(&self, http: &Client, track: &TrackInfo) -> Option<LyricsDoc> {
        let key = crate::normalize::track_key(track);
        let query = format!("{} {}", track.title, track.artist);
        let candidates = self.search(http, &query).await;
        let idx = best_match(track, &candidates)?;
        let cand = candidates.get(idx)?;
        let (id, src_dur) = (cand.id.clone(), cand.duration_ms);
        self.syllable_doc(http, &id, &key, src_dur).await
    }

    async fn search(&self, http: &Client, query: &str) -> Vec<SearchCandidate> {
        let url = format!("{AMP}/{}/search", self.storefront);
        let resp = self
            .auth(http.get(url))
            .query(&[("term", query), ("types", "songs"), ("limit", "10")])
            .send()
            .await;
        let Ok(v) = (match resp {
            Ok(r) => r.json::<Value>().await,
            Err(_) => return Vec::new(),
        }) else {
            return Vec::new();
        };
        let Some(data) = v
            .get("results")
            .and_then(|r| r.get("songs"))
            .and_then(|s| s.get("data"))
            .and_then(Value::as_array)
        else {
            return Vec::new();
        };
        data.iter().filter_map(candidate_from_song).collect()
    }

    async fn fetch_candidate(&self, http: &Client, cand: &SearchCandidate) -> Option<LyricsDoc> {
        let key = super::candidate_key(cand);
        self.syllable_doc(http, &cand.id, &key, cand.duration_ms).await
    }
}

fn candidate_from_song(song: &Value) -> Option<SearchCandidate> {
    let id = song.get("id")?.as_str()?.to_string();
    let attrs = song.get("attributes")?;
    Some(SearchCandidate {
        source: crate::lyrics::SourceId::Applemusic,
        id,
        title: attrs.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
        artist: attrs.get("artistName").and_then(Value::as_str).unwrap_or_default().to_string(),
        album: attrs.get("albumName").and_then(Value::as_str).unwrap_or_default().to_string(),
        duration_ms: attrs.get("durationInMillis").and_then(Value::as_i64).map(|d| d as u64),
        has_word_timing: Some(true),
    })
}
