// Musixmatch (unofficial desktop API) — word-level "richsync".
//
// UNOFFICIAL: can break, rate-limit or return a captcha at any time. Fully
// isolated and fail-soft: every error degrades to `None`/empty so the chain
// falls through to the next provider. One attempt per track fetch.
//
// Flow: token.get (sets/needs an AWSELB cookie, replayed via the shared cookie
// jar) -> macro.subtitles.get (line-level + track id + has_richsync) ->
// track.richsync.get (word-level) when available.
use std::fs;
use std::path::PathBuf;

use reqwest::Client;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::lyrics::{LyricsDoc, SourceId};
use crate::matching::similarity;
use crate::model::{SearchCandidate, TrackInfo};
use crate::parse::{parse_lrc, parse_richsync};

use super::Provider;

const BASE: &str = "https://apic-desktop.musixmatch.com/ws/1.1";
const APP_ID: &str = "web-desktop-app-v1.0";

pub struct Musixmatch {
    token_path: Option<PathBuf>,
    /// Target language for the keyless crowd-translation lookup (None = off).
    translate_to: Option<String>,
}

impl Musixmatch {
    pub fn new<R: Runtime>(app: &AppHandle<R>) -> Self {
        let token_path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("musixmatch_token.json"));
        let translate_to = crate::config::load(app).translation.wanted_lang();
        Self {
            token_path,
            translate_to,
        }
    }

    fn load_token(&self) -> Option<String> {
        let path = self.token_path.as_ref()?;
        let bytes = fs::read(path).ok()?;
        let v: Value = serde_json::from_slice(&bytes).ok()?;
        v.get("token")?.as_str().map(str::to_string)
    }

    fn save_token(&self, token: &str) {
        if let Some(path) = &self.token_path {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::write(path, serde_json::json!({ "token": token }).to_string());
        }
    }

    /// Acquire a user token (disk-cached), refreshing on captcha/failure.
    async fn user_token(&self, http: &Client) -> Option<String> {
        if let Some(t) = self.load_token() {
            return Some(t);
        }
        let v = get_json(http, "token.get", &[("app_id", APP_ID)], None).await?;
        if status_code(&v) != 200 {
            return None; // captcha / rate-limited
        }
        let token = dig(&v, &["message", "body", "user_token"])?
            .as_str()?
            .to_string();
        if token.is_empty() || token == "UpgradeOnlyUponHitError" {
            return None;
        }
        self.save_token(&token);
        Some(token)
    }

    /// macro.subtitles.get -> (track_id, has_richsync, line-level LRC).
    async fn macro_subtitles(
        &self,
        http: &Client,
        token: &str,
        track: &TrackInfo,
    ) -> Option<(i64, bool, Option<String>, String, Option<String>)> {
        let dur = (track.duration_ms / 1000).to_string();
        let v = get_json(
            http,
            "macro.subtitles.get",
            &[
                ("app_id", APP_ID),
                ("subtitle_format", "lrc"),
                ("q_track", &track.title),
                ("q_artist", &track.artist),
                ("q_duration", &dur),
            ],
            Some(token),
        )
        .await?;

        let calls = dig(&v, &["message", "body", "macro_calls"])?;
        let track_obj = dig(
            calls,
            &["matcher.track.get", "message", "body", "track"],
        )?;
        let track_id = track_obj.get("track_id")?.as_i64()?;
        let has_richsync = track_obj
            .get("has_richsync")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            == 1;
        let track_name = track_obj
            .get("track_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        // Track's own lyrics language (ISO code). Used to skip crowd
        // translations into a language the song is already written in.
        let language = track_obj
            .get("track_lyrics_language")
            .or_else(|| track_obj.get("language"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_lowercase());

        let lrc = dig(
            calls,
            &[
                "track.subtitles.get",
                "message",
                "body",
                "subtitle_list",
            ],
        )
        .and_then(|list| list.get(0))
        .and_then(|s| dig(s, &["subtitle", "subtitle_body"]))
        .and_then(Value::as_str)
        .map(str::to_string);

        Some((track_id, has_richsync, lrc, track_name, language))
    }

    async fn richsync(&self, http: &Client, token: &str, track_id: i64) -> Option<String> {
        let id = track_id.to_string();
        let v = get_json(
            http,
            "track.richsync.get",
            &[("app_id", APP_ID), ("track_id", &id)],
            Some(token),
        )
        .await?;
        dig(&v, &["message", "body", "richsync", "richsync_body"])?
            .as_str()
            .map(str::to_string)
    }

    /// Keyless crowd translations for the track into `lang`, as (original,
    /// translation) pairs. Fail-soft: any error yields an empty list.
    async fn translations(
        &self,
        http: &Client,
        token: &str,
        track_id: i64,
        lang: &str,
    ) -> Vec<(String, String)> {
        let id = track_id.to_string();
        let Some(v) = get_json(
            http,
            "crowd.track.translations.get",
            &[
                ("app_id", APP_ID),
                ("track_id", &id),
                ("selected_language", lang),
                ("comment_format", "text"),
                ("part", "user"),
                ("translation_fields_set", "minimal"),
            ],
            Some(token),
        )
        .await
        else {
            return Vec::new();
        };
        let Some(list) =
            dig(&v, &["message", "body", "translations_list"]).and_then(Value::as_array)
        else {
            return Vec::new();
        };
        list.iter()
            .filter_map(|item| {
                let t = item.get("translation")?;
                let original = t.get("matched_line").and_then(Value::as_str)?.trim();
                let translated = t.get("description").and_then(Value::as_str)?.trim();
                (!original.is_empty() && !translated.is_empty())
                    .then(|| (original.to_string(), translated.to_string()))
            })
            .collect()
    }

    /// Enrich a doc with crowd translations, matching by original line text.
    /// `track_lang` is the song's own lyrics language: when it matches the
    /// target, the lyrics are already in the wanted language, so we skip the
    /// lookup (the crowd endpoint otherwise returns stray other-language
    /// submissions, e.g. a Filipino "translation" on an English song).
    async fn enrich_translations(
        &self,
        http: &Client,
        token: &str,
        track_id: i64,
        doc: &mut LyricsDoc,
        track_lang: Option<&str>,
    ) {
        let Some(lang) = &self.translate_to else {
            return;
        };
        if track_lang.is_some_and(|tl| tl.eq_ignore_ascii_case(lang)) {
            return;
        }
        if doc.lines.is_empty() {
            return;
        }
        let pairs = self.translations(http, token, track_id, lang).await;
        if pairs.is_empty() {
            return;
        }
        for line in doc.lines.iter_mut() {
            let key = line.text.trim();
            if key.is_empty() {
                continue;
            }
            if let Some((_, tr)) = pairs.iter().find(|(orig, _)| orig == key) {
                line.translation = Some(tr.clone());
            }
        }
    }
}

impl Provider for Musixmatch {
    async fn fetch(&self, http: &Client, track: &TrackInfo) -> Option<LyricsDoc> {
        let key = crate::normalize::track_key(track);
        let token = self.user_token(http).await?;
        let (track_id, has_richsync, lrc, track_name, language) =
            self.macro_subtitles(http, &token, track).await?;

        // Guard against a wildly wrong server match.
        if !track.title.is_empty() && similarity(&track.title, &track_name) < 0.4 {
            return None;
        }

        let mut doc = None;
        if has_richsync {
            if let Some(body) = self.richsync(http, &token, track_id).await {
                doc = parse_richsync(&body, &key).ok();
            }
        }
        // Fall back to line-level subtitles.
        if doc.is_none() {
            doc = parse_lrc(lrc.as_deref()?, SourceId::Musixmatch, &key).ok();
        }
        let mut doc = doc?;
        // Keyless crowd translations (e.g. zh -> en) attached per line when the
        // user shows translations; AI stays a later fallback for missing lines.
        self.enrich_translations(http, &token, track_id, &mut doc, language.as_deref())
            .await;
        Some(doc)
    }

    async fn search(&self, http: &Client, query: &str) -> Vec<SearchCandidate> {
        let Some(token) = self.user_token(http).await else {
            return Vec::new();
        };
        let Some(v) = get_json(
            http,
            "track.search",
            &[
                ("app_id", APP_ID),
                ("q", query),
                ("page_size", "10"),
                ("s_track_rating", "desc"),
            ],
            Some(&token),
        )
        .await
        else {
            return Vec::new();
        };
        let Some(list) = dig(&v, &["message", "body", "track_list"]).and_then(Value::as_array) else {
            return Vec::new();
        };
        list.iter()
            .filter_map(|item| item.get("track").and_then(candidate_from_track))
            .collect()
    }

    async fn fetch_candidate(&self, http: &Client, cand: &SearchCandidate) -> Option<LyricsDoc> {
        let token = self.user_token(http).await?;
        let track_id: i64 = cand.id.parse().ok()?;
        let key = super::candidate_key(cand);
        let mut doc = None;
        if let Some(body) = self.richsync(http, &token, track_id).await {
            doc = parse_richsync(&body, &key).ok();
        }
        if doc.is_none() {
            // Line-level fallback via track.subtitles.get.
            let v = get_json(
                http,
                "track.subtitles.get",
                &[("app_id", APP_ID), ("track_id", &cand.id), ("subtitle_format", "lrc")],
                Some(&token),
            )
            .await?;
            let lrc = dig(&v, &["message", "body", "subtitle_list"])
                .and_then(|l| l.get(0))
                .and_then(|s| dig(s, &["subtitle", "subtitle_body"]))?
                .as_str()?;
            doc = parse_lrc(lrc, SourceId::Musixmatch, &key).ok();
        }
        let mut doc = doc?;
        self.enrich_translations(http, &token, track_id, &mut doc, None)
            .await;
        Some(doc)
    }
}

fn candidate_from_track(track: &Value) -> Option<SearchCandidate> {
    let id = track.get("track_id")?.as_i64()?;
    Some(SearchCandidate {
        source: SourceId::Musixmatch,
        id: id.to_string(),
        title: track.get("track_name").and_then(Value::as_str).unwrap_or_default().to_string(),
        artist: track.get("artist_name").and_then(Value::as_str).unwrap_or_default().to_string(),
        album: track.get("album_name").and_then(Value::as_str).unwrap_or_default().to_string(),
        duration_ms: track.get("track_length").and_then(Value::as_i64).map(|s| s as u64 * 1000),
        has_word_timing: track.get("has_richsync").and_then(Value::as_i64).map(|r| r == 1),
    })
}

async fn get_json(
    http: &Client,
    endpoint: &str,
    params: &[(&str, &str)],
    token: Option<&str>,
) -> Option<Value> {
    let mut req = http
        .get(format!("{BASE}/{endpoint}"))
        .query(&[("format", "json")])
        .query(params);
    if let Some(t) = token {
        req = req.query(&[("usertoken", t)]);
    }
    let resp = req.send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<Value>().await.ok()
}

fn status_code(v: &Value) -> i64 {
    dig(v, &["message", "header", "status_code"])
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

fn dig<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for k in path {
        cur = cur.get(k)?;
    }
    Some(cur)
}
